//! Anthropic Messages API surface (`/v1/messages`) — Claude Code compatibility.
//!
//! Claude Code speaks the Anthropic wire protocol (`x-api-key`, `/v1/messages`,
//! content blocks, `stop_reason`, its own SSE event grammar). Rhodochrosite's upstreams
//! speak OpenAI chat completions. This module translates between the two and
//! delegates the actual request to the standard proxy path, so every Anthropic
//! request gets the same pacing, key-pool rotation, governor, circuit, and
//! history treatment as a native OpenAI call. Nothing upstream changes; this
//! is a pure protocol shim (additive; invariant 4 — the OpenAI wire format
//! does not move).
//!
//! Layout:
//! - [`translate_request`] Anthropic body → OpenAI chat body (pure, tested)
//! - [`translate_response`] OpenAI JSON → Anthropic message JSON (pure, tested)
//! - [`SseTranslator`] OpenAI SSE chunks → Anthropic event stream (tested)
//! - [`messages`] / [`count_tokens`] axum handlers; the former re-enters
//!   [`crate::proxy::handle`] with the translated body so the relay, strikes,
//!   metrics, and history all see one canonical request shape.

use std::sync::Arc;

use axum::{
	extract::State,
	http::{HeaderMap, Method, Uri, header},
	response::Response,
};
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{Value, json};

use crate::AppState;

/// Model requested when the client asks for a `claude-*` id (or omits the
/// model): the strongest verified NIM model, overridable per deployment via
/// `RHODOCHROSITE_ANTHROPIC_DEFAULT_MODEL`.
const DEFAULT_ANTHROPIC_MODEL: &str = "nvidia/nemotron-3.5-super-vl-120b-a12b";

fn default_model() -> String {
	std::env::var("RHODOCHROSITE_ANTHROPIC_DEFAULT_MODEL")
		.ok()
		.filter(|m| !m.trim().is_empty())
		.unwrap_or_else(|| DEFAULT_ANTHROPIC_MODEL.to_owned())
}

/// Map an Anthropic error status to the protocol's error `type` vocabulary.
fn error_type(status: u16) -> &'static str {
	match status {
		401 | 403 => "authentication_error",
		404 => "not_found_error",
		429 => "rate_limit_error",
		400..=422 => "invalid_request_error",
		500..=599 => "api_error",
		_ => "api_error",
	}
}

/// Wrap an upstream failure in the Anthropic error envelope.
pub fn error_response(status: u16, message: &str) -> Response {
	let body = json!({
		 "type": "error",
		 "error": { "type": error_type(status), "message": message },
	});
	crate::proxy::json_response(
		axum::http::StatusCode::from_u16(status)
			.unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
		Bytes::from(serde_json::to_vec(&body).unwrap_or_default()),
	)
}

fn text_blocks_to_string(blocks: &[Value]) -> String {
	blocks
		.iter()
		.filter_map(|b| b.get("text").and_then(|t| t.as_str()))
		.collect::<Vec<_>>()
		.join("")
}

/// Flatten an Anthropic `system` field (string or `{type:"text"}` blocks)
/// into an OpenAI system message, if present.
fn system_message(system: Option<&Value>) -> Option<Value> {
	let text = match system? {
		Value::String(s) => Some(s.clone()),
		Value::Array(blocks) => {
			let joined = text_blocks_to_string(blocks);
			(!joined.is_empty()).then_some(joined)
		},
		_ => None,
	}?;
	Some(json!({ "role": "system", "content": text }))
}

/// Translate one Anthropic content-block list into OpenAI content: either a
/// plain string (text only) or a part array (text + images).
fn content_blocks_to_openai(blocks: &[Value]) -> Value {
	let mut parts: Vec<Value> = Vec::new();
	let mut texts: Vec<&str> = Vec::new();
	for b in blocks {
		match b.get("type").and_then(|t| t.as_str()) {
			Some("text") => {
				if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
					texts.push(t);
				}
			},
			Some("image") => {
				let url = match b.get("source") {
					Some(src) if src.get("type").and_then(|t| t.as_str()) == Some("base64") => {
						format!(
							"data:{};base64,{}",
							src.get("media_type")
								.and_then(|m| m.as_str())
								.unwrap_or("image/png"),
							src.get("data").and_then(|d| d.as_str()).unwrap_or("")
						)
					},
					Some(src) => src
						.get("url")
						.and_then(|u| u.as_str())
						.unwrap_or("")
						.to_owned(),
					None => String::new(),
				};
				if !url.is_empty() {
					parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
				}
			},
			_ => {},
		}
	}
	if parts.is_empty() {
		return Value::String(texts.join(""));
	}
	for t in texts {
		parts.insert(0, json!({ "type": "text", "text": t }));
	}
	Value::Array(parts)
}

/// Anthropic `tools[]` → OpenAI `tools[]` (input_schema becomes parameters).
fn translate_tools(tools: Option<&Value>) -> Option<Value> {
	let arr = tools?.as_array()?;
	let out: Vec<Value> = arr
		.iter()
		.filter_map(|t| {
			let name = t.get("name")?.as_str()?;
			Some(json!({
				 "type": "function",
				 "function": {
					  "name": name,
					  "description": t.get("description").cloned().unwrap_or(Value::Null),
					  "parameters": t.get("input_schema").cloned().unwrap_or(json!({ "type": "object" })),
				 },
			}))
		})
		.collect();
	(!out.is_empty()).then(|| Value::Array(out))
}

/// Anthropic `tool_choice` → OpenAI `tool_choice`.
fn translate_tool_choice(tc: Option<&Value>) -> Option<Value> {
	let tc = tc?;
	match tc.get("type").and_then(|t| t.as_str())? {
		"auto" => Some(json!("auto")),
		"any" => Some(json!("required")),
		"tool" => {
			let name = tc.get("name").and_then(|n| n.as_str())?;
			Some(json!({ "type": "function", "function": { "name": name } }))
		},
		_ => None,
	}
}

/// Translate an Anthropic Messages request into an OpenAI chat completions
/// body. Pure function; the only fallback is the default model for
/// `claude-*` ids.
pub fn translate_request(body: &Value) -> Result<Value, String> {
	if body.get("messages").and_then(|m| m.as_array()).is_none() {
		return Err("messages: array of role/content blocks is required".into());
	}
	let requested = body.get("model").and_then(|m| m.as_str()).unwrap_or("");
	let model = if requested.is_empty() || requested.starts_with("claude") {
		default_model()
	} else {
		requested.to_owned()
	};

	let mut out = json!({
		 "model": model,
		 "max_tokens": body.get("max_tokens").cloned().unwrap_or(json!(4096)),
		 "stream": body.get("stream").cloned().unwrap_or(json!(false)),
	});

	let mut messages: Vec<Value> = Vec::new();
	if let Some(sys) = system_message(body.get("system")) {
		messages.push(sys);
	}

	for m in body["messages"].as_array().unwrap() {
		let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
		let content = m.get("content");
		match content {
			Some(Value::String(s)) => messages.push(json!({ "role": role, "content": s })),
			Some(Value::Array(blocks)) => {
				// Assistant turns may carry tool_use blocks → OpenAI tool_calls.
				let tool_calls: Vec<Value> = blocks
					.iter()
					.filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
					.filter_map(|b| {
						Some(json!({
							 "id": b.get("id").cloned().unwrap_or(json!("call_0")),
							 "type": "function",
							 "function": {
								  "name": b.get("name").cloned().unwrap_or(json!("")),
								  "arguments": serde_json::to_string(
										&b.get("input").cloned().unwrap_or(json!({})),
								  ).unwrap_or_default(),
							 },
						}))
					})
					.collect();
				// User turns may carry tool_result blocks → OpenAI tool messages.
				let tool_results: Vec<Value> = blocks
					.iter()
					.filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
					.filter_map(|b| {
						let content = match b.get("content") {
							Some(Value::String(s)) => s.clone(),
							Some(Value::Array(inner)) => text_blocks_to_string(inner),
							_ => String::new(),
						};
						Some(json!({
							 "role": "tool",
							 "tool_call_id": b.get("tool_use_id").cloned().unwrap_or(json!("call_0")),
							 "content": content,
						}))
					})
					.collect();
				if !tool_results.is_empty() {
					messages.extend(tool_results);
					continue;
				}
				let mut msg = json!({ "role": role, "content": content_blocks_to_openai(blocks) });
				if !tool_calls.is_empty() {
					msg["tool_calls"] = Value::Array(tool_calls);
					msg["content"] = Value::Null;
				}
				messages.push(msg);
			},
			_ => messages.push(json!({ "role": role, "content": "" })),
		}
	}
	out["messages"] = Value::Array(messages);

	if let Some(t) = translate_tools(body.get("tools")) {
		out["tools"] = t;
	}
	if let Some(tc) = translate_tool_choice(body.get("tool_choice")) {
		out["tool_choice"] = tc;
	}
	if let Some(stop) = body.get("stop_sequences") {
		if stop.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
			out["stop"] = stop.clone();
		}
	}
	for key in ["temperature", "top_p"] {
		if let Some(v) = body.get(key) {
			out[key] = v.clone();
		}
	}
	Ok(out)
}

/// Map an OpenAI finish_reason to the Anthropic stop_reason vocabulary.
fn stop_reason(finish: Option<&str>) -> &'static str {
	match finish {
		Some("tool_calls") => "tool_use",
		Some("length") => "max_tokens",
		_ => "end_turn",
	}
}

/// Anthropic content blocks for an OpenAI assistant message: text first,
/// then one `tool_use` block per tool call.
fn message_content_blocks(message: &Value) -> Vec<Value> {
	let mut blocks: Vec<Value> = Vec::new();
	if let Some(text) = message.get("content").and_then(|c| c.as_str()) {
		if !text.is_empty() {
			blocks.push(json!({ "type": "text", "text": text }));
		}
	}
	if let Some(calls) = message.get("tool_calls").and_then(|c| c.as_array()) {
		for call in calls {
			let name = call
				.pointer("/function/name")
				.and_then(|n| n.as_str())
				.unwrap_or("");
			let args = call
				.pointer("/function/arguments")
				.and_then(|a| a.as_str())
				.unwrap_or("{}");
			let input: Value = serde_json::from_str(args).unwrap_or(json!({}));
			blocks.push(json!({
				 "type": "tool_use",
				 "id": call.get("id").cloned().unwrap_or(json!("call_0")),
				 "name": name,
				 "input": input,
			}));
		}
	}
	if blocks.is_empty() {
		blocks.push(json!({ "type": "text", "text": "" }));
	}
	blocks
}

/// Translate a non-streaming OpenAI chat response into an Anthropic message.
pub fn translate_response(openai: &Value, requested_model: &str) -> Value {
	let choice = openai
		.get("choices")
		.and_then(|c| c.get(0))
		.cloned()
		.unwrap_or(json!({}));
	let message = choice.get("message").cloned().unwrap_or(json!({}));
	let usage = openai.get("usage").cloned().unwrap_or(json!({}));
	json!({
		 "id": openai.get("id").cloned().unwrap_or(json!("msg_rhodochrosite")),
		 "type": "message",
		 "role": "assistant",
		 "model": requested_model,
		 "content": message_content_blocks(&message),
		 "stop_reason": stop_reason(choice.get("finish_reason").and_then(|f| f.as_str())),
		 "stop_sequence": Value::Null,
		 "usage": {
			  "input_tokens": usage.get("prompt_tokens").cloned().unwrap_or(json!(0)),
			  "output_tokens": usage.get("completion_tokens").cloned().unwrap_or(json!(0)),
		 },
	})
}

/// Streaming translator: feed OpenAI SSE `data:` payloads, collect Anthropic
/// events. Emits `message_start` on the first chunk, text/tool deltas as
/// `content_block_delta`, and closes with `message_delta` + `message_stop`.
#[derive(Default)]
pub struct SseTranslator {
	started:         bool,
	text_open:       bool,
	/// tool index → (block_index, tool_call_id, name)
	tools:           std::collections::HashMap<u64, (usize, String, String)>,
	next_block:      usize,
	finished:        bool,
	requested_model: String,
	input_tokens:    u64,
	output_tokens:   u64,
}

fn sse_event(event: &str, data: &Value) -> String {
	format!("event: {}\ndata: {}\n\n", event, data)
}

impl SseTranslator {
	pub fn new(requested_model: &str) -> Self {
		Self { requested_model: requested_model.to_owned(), ..Default::default() }
	}

	/// Whether the stream has been closed with message_stop.
	pub fn finished(&self) -> bool {
		self.finished
	}

	/// Translate one OpenAI chunk payload. Returns the Anthropic events to
	/// emit (possibly several, possibly none for keep-alive/empty chunks).
	pub fn feed(&mut self, chunk: &str) -> Vec<String> {
		let mut out = Vec::new();
		if chunk.trim() == "[DONE]" {
			out.extend(self.close());
			return out;
		}
		let v: Value = match serde_json::from_str(chunk) {
			Ok(v) => v,
			Err(_) => return out, // non-JSON keep-alive line
		};
		if !self.started {
			self.started = true;
			let usage_in = v
				.pointer("/usage/prompt_tokens")
				.and_then(|u| u.as_u64())
				.unwrap_or(0);
			self.input_tokens = usage_in;
			out.push(sse_event(
				"message_start",
				&json!({
					 "type": "message_start",
					 "message": {
						  "id": v.get("id").cloned().unwrap_or(json!("msg_rhodochrosite")),
						  "type": "message",
						  "role": "assistant",
						  "model": self.requested_model,
						  "content": [],
						  "stop_reason": Value::Null,
						  "stop_sequence": Value::Null,
						  "usage": { "input_tokens": usage_in, "output_tokens": 0 },
					 },
				}),
			));
		}
		let choice = v
			.get("choices")
			.and_then(|c| c.get(0))
			.cloned()
			.unwrap_or(json!({}));
		let delta = choice.get("delta").cloned().unwrap_or(json!({}));

		if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
			if !text.is_empty() {
				if !self.text_open {
					let idx = self.next_block;
					self.next_block += 1;
					self.text_open = true;
					out.push(sse_event(
						"content_block_start",
						&json!({
							 "type": "content_block_start",
							 "index": idx,
							 "content_block": { "type": "text", "text": "" },
						}),
					));
				}
				let idx = self.next_block - 1;
				out.push(sse_event(
					"content_block_delta",
					&json!({
						 "type": "content_block_delta",
						 "index": idx,
						 "delta": { "type": "text_delta", "text": text },
					}),
				));
			}
		}

		if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
			for call in calls {
				let tool_idx = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
				let entry = self.tools.entry(tool_idx).or_insert_with(|| {
					let block = self.next_block;
					self.next_block += 1;
					let id = call
						.get("id")
						.and_then(|i| i.as_str())
						.unwrap_or("call_0")
						.to_owned();
					let name = call
						.pointer("/function/name")
						.and_then(|n| n.as_str())
						.unwrap_or("")
						.to_owned();
					out.push(sse_event(
						"content_block_start",
						&json!({
							 "type": "content_block_start",
							 "index": block,
							 "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} },
						}),
					));
					(block, id, name)
				});
				let _ = &mut entry.1;
				if let Some(args) = call.pointer("/function/arguments").and_then(|a| a.as_str()) {
					if !args.is_empty() {
						out.push(sse_event(
							"content_block_delta",
							&json!({
								 "type": "content_block_delta",
								 "index": entry.0,
								 "delta": { "type": "input_json_delta", "partial_json": args },
							}),
						));
					}
				}
			}
		}

		if let Some(finish) = choice.get("finish_reason").and_then(|f| f.as_str()) {
			let reason = stop_reason(Some(finish));
			if let Some(u) = v.get("usage") {
				if let Some(n) = u.get("completion_tokens").and_then(|n| n.as_u64()) {
					self.output_tokens = n;
				}
			}
			out.extend(self.close_with(reason));
		}
		out
	}

	fn close_blocks(&mut self, out: &mut Vec<String>) {
		let _ = &mut self.text_open;
		for i in 0..self.next_block {
			out.push(sse_event(
				"content_block_stop",
				&json!({ "type": "content_block_stop", "index": i }),
			));
		}
		self.text_open = false;
	}

	fn close_with(&mut self, reason: &str) -> Vec<String> {
		let mut out = Vec::new();
		self.close_blocks(&mut out);
		out.push(sse_event(
			"message_delta",
			&json!({
				 "type": "message_delta",
				 "delta": { "stop_reason": reason, "stop_sequence": Value::Null },
				 "usage": { "output_tokens": self.output_tokens },
			}),
		));
		out.push(sse_event("message_stop", &json!({ "type": "message_stop" })));
		self.finished = true;
		out
	}

	/// Emit any missing closing events (upstream ended without finish_reason
	/// or [DONE] — e.g. deadline cut). Idempotent.
	pub fn close(&mut self) -> Vec<String> {
		if self.finished {
			return Vec::new();
		}
		self.close_with("end_turn")
	}
}

/// `POST /v1/messages` — translate, delegate to the standard proxy path,
/// translate the response back (JSON or Anthropic SSE events).
pub async fn messages(
	State(state): State<Arc<AppState>>,
	method: Method,
	mut headers: HeaderMap,
	body: Bytes,
) -> Response {
	let requested_model = serde_json::from_slice::<Value>(&body)
		.ok()
		.and_then(|v| v.get("model").and_then(|m| m.as_str()).map(String::from))
		.unwrap_or_default();

	let translated = match serde_json::from_slice::<Value>(&body) {
		Ok(v) => match translate_request(&v) {
			Ok(t) => t,
			Err(reason) => return error_response(400, &reason),
		},
		Err(e) => return error_response(400, &format!("invalid JSON body: {e}")),
	};

	// Claude Code authenticates with `x-api-key`; the proxy gate reads
	// `Authorization: Bearer`. Copy one into the other (Bearer wins if both).
	if !headers.contains_key(header::AUTHORIZATION) {
		if let Some(key) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
			if let Ok(v) = header::HeaderValue::from_str(&format!("Bearer {key}")) {
				headers.insert(header::AUTHORIZATION, v);
			}
		}
	}

	let wants_stream = translated
		.get("stream")
		.and_then(|s| s.as_bool())
		.unwrap_or(false);
	let new_body = match serde_json::to_vec(&translated) {
		Ok(b) => Bytes::from(b),
		Err(e) => return error_response(500, &format!("translate: {e}")),
	};
	let uri = Uri::builder()
		.path_and_query("/v1/chat/completions")
		.build()
		.unwrap_or_default();

	let upstream = crate::proxy::handle(State(state), method, uri, headers, new_body).await;
	translate_upstream_response(upstream, &requested_model, wants_stream).await
}

/// Rewrite an OpenAI-shaped proxy response into the Anthropic wire format.
async fn translate_upstream_response(
	upstream: Response,
	requested_model: &str,
	wants_stream: bool,
) -> Response {
	let status = upstream.status();
	if !status.is_success() {
		let status_u16 = status.as_u16();
		let (parts, body) = upstream.into_parts();
		let bytes = body
			.collect()
			.await
			.map(|c| c.to_bytes())
			.unwrap_or_default();
		let message = serde_json::from_slice::<Value>(&bytes)
			.ok()
			.and_then(|v| {
				v.pointer("/error/message")
					.or_else(|| v.get("message"))
					.and_then(|m| m.as_str())
					.map(String::from)
			})
			.unwrap_or_else(|| format!("upstream status {status_u16}"));
		let _ = parts;
		return error_response(status_u16, &message);
	}

	let (parts, body) = upstream.into_parts();
	if !wants_stream {
		let bytes = match body.collect().await {
			Ok(c) => c.to_bytes(),
			Err(e) => return error_response(502, &format!("upstream body: {e}")),
		};
		let openai: Value = match serde_json::from_slice(&bytes) {
			Ok(v) => v,
			Err(e) => return error_response(502, &format!("upstream JSON: {e}")),
		};
		let anthropic = translate_response(&openai, requested_model);
		return crate::proxy::json_response(
			parts.status,
			Bytes::from(serde_json::to_vec(&anthropic).unwrap_or_default()),
		);
	}

	// Streaming: re-frame the relayed SSE as Anthropic events.
	let model = requested_model.to_owned();
	let stream = body.into_data_stream();
	let translated = futures_util::stream::unfold(
		(stream, SseTranslator::new(&model), String::new(), Vec::<String>::new()),
		|(mut stream, mut t, mut buf, mut queue)| async move {
			loop {
				if let Some(event) = (!queue.is_empty()).then(|| queue.remove(0)) {
					return Some((
						Ok::<Bytes, std::io::Error>(Bytes::from(event)),
						(stream, t, buf, queue),
					));
				}
				if t.finished() {
					return None;
				}
				match stream.next().await {
					Some(Ok(chunk)) => {
						buf.push_str(&String::from_utf8_lossy(&chunk));
						while let Some(pos) = buf.find('\n') {
							let line: String = buf.drain(..=pos).collect();
							let line = line.trim_end();
							if let Some(data) = line.strip_prefix("data:") {
								for event in t.feed(data.trim()) {
									queue.push(event);
								}
							}
						}
					},
					Some(Err(e)) => {
						return Some((
							Err(std::io::Error::new(std::io::ErrorKind::Other, e)),
							(stream, t, buf, queue),
						));
					},
					None => {
						let closing = t.close();
						if closing.is_empty() {
							return None;
						}
						let joined: String = closing.concat();
						return Some((Ok(Bytes::from(joined)), (stream, t, buf, queue)));
					},
				}
			}
		},
	);
	Response::from_parts(parts, axum::body::Body::from_stream(translated))
}

/// `POST /v1/messages/count_tokens` — local estimate, no upstream call.
/// Characters/4 matches the routing heuristic used for context-budgeting.
pub async fn count_tokens(body: Bytes) -> Response {
	let estimate = serde_json::from_slice::<Value>(&body)
		.map(|v| {
			let mut chars = 0usize;
			if let Some(s) = v.get("system").and_then(|s| s.as_str()) {
				chars += s.len();
			}
			if let Some(msgs) = v.get("messages").and_then(|m| m.as_array()) {
				for m in msgs {
					match m.get("content") {
						Some(Value::String(s)) => chars += s.len(),
						Some(Value::Array(blocks)) => chars += text_blocks_to_string(blocks).len(),
						_ => {},
					}
					chars += 4; // per-message framing overhead
				}
			}
			if let Some(tools) = v.get("tools").and_then(|t| t.as_array()) {
				chars += serde_json::to_string(tools).map(|s| s.len()).unwrap_or(0);
			}
			(chars / 4).max(1) as u64
		})
		.unwrap_or(1);
	crate::proxy::json_response(
		axum::http::StatusCode::OK,
		Bytes::from(serde_json::to_vec(&json!({ "input_tokens": estimate })).unwrap_or_default()),
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn stop_reason_maps_the_openai_vocabulary() {
		assert_eq!(stop_reason(Some("tool_calls")), "tool_use");
		assert_eq!(stop_reason(Some("length")), "max_tokens");
		assert_eq!(stop_reason(Some("stop")), "end_turn");
		assert_eq!(stop_reason(None), "end_turn");
	}

	#[test]
	fn error_type_maps_status_to_anthropic_vocabulary() {
		assert_eq!(error_type(401), "authentication_error");
		assert_eq!(error_type(403), "authentication_error");
		assert_eq!(error_type(404), "not_found_error");
		assert_eq!(error_type(429), "rate_limit_error");
		assert_eq!(error_type(400), "invalid_request_error");
		assert_eq!(error_type(422), "invalid_request_error");
		assert_eq!(error_type(503), "api_error");
	}

	#[test]
	fn error_response_produces_the_anthropic_error_envelope() {
		let resp = error_response(429, "slow down");
		assert_eq!(resp.status().as_u16(), 429);
	}

	#[test]
	fn translate_request_rejects_missing_messages() {
		let err = translate_request(&json!({ "model": "claude-3" })).unwrap_err();
		assert!(err.contains("messages"));
	}

	#[test]
	fn translate_request_defaults_model_and_max_tokens_for_claude() {
		let out = translate_request(&json!({
			"messages": [{ "role": "user", "content": "hi" }]
		}))
		.unwrap();
		assert_eq!(out["max_tokens"], json!(4096));
		assert_eq!(out["stream"], json!(false));
		assert_eq!(out["model"], json!(default_model()));
	}

	#[test]
	fn translate_request_keeps_a_non_claude_model_and_passes_system() {
		let out = translate_request(&json!({
			"model": "openai/gpt-6.1-terra",
			"system": "be terse",
			"max_tokens": 128,
			"messages": [{ "role": "user", "content": "hi" }],
		}))
		.unwrap();
		assert_eq!(out["model"], json!("openai/gpt-6.1-terra"));
		assert_eq!(out["max_tokens"], json!(128));
		assert_eq!(out["messages"][0]["role"], json!("system"));
		assert_eq!(out["messages"][0]["content"], json!("be terse"));
	}

	#[test]
	fn translate_request_converts_tool_use_and_tool_result_blocks() {
		let out = translate_request(&json!({
			"model": "x",
			"messages": [
				{
					"role": "assistant",
					"content": [{
						"type": "tool_use",
						"id": "call_9",
						"name": "weather",
						"input": { "zip": "10001" },
					}],
				},
				{
					"role": "user",
					"content": [{
						"type": "tool_result",
						"tool_use_id": "call_9",
						"content": "sunny",
					}],
				},
			],
		}))
		.unwrap();
		let assistant = &out["messages"][0];
		assert_eq!(assistant["role"], json!("assistant"));
		assert_eq!(assistant["content"], Value::Null);
		assert_eq!(assistant["tool_calls"][0]["id"], json!("call_9"));
		assert_eq!(assistant["tool_calls"][0]["function"]["name"], json!("weather"));
		let tool = &out["messages"][1];
		assert_eq!(tool["role"], json!("tool"));
		assert_eq!(tool["tool_call_id"], json!("call_9"));
		assert_eq!(tool["content"], json!("sunny"));
	}

	#[test]
	fn translate_request_passes_tools_and_tool_choice() {
		let out = translate_request(&json!({
			"model": "x",
			"messages": [{ "role": "user", "content": "go" }],
			"tools": [{ "name": "t", "description": "d", "input_schema": {"type": "object"} }],
			"tool_choice": { "type": "auto" },
		}))
		.unwrap();
		assert_eq!(out["tools"][0]["type"], json!("function"));
		assert_eq!(out["tools"][0]["function"]["name"], json!("t"));
		assert_eq!(out["tool_choice"], json!("auto"));
	}

	#[test]
	fn content_blocks_flatten_text_and_build_image_urls() {
		let flat = content_blocks_to_openai(&[json!({ "type": "text", "text": "abc" })]);
		assert_eq!(flat, json!("abc"));
		let parts = content_blocks_to_openai(&[json!({
			"type": "image",
			"source": {
				"type": "base64",
				"media_type": "image/png",
				"data": "AAA",
			},
		})]);
		assert_eq!(parts.as_array().unwrap().len(), 1);
		let url = parts[0]["image_url"]["url"].as_str().unwrap();
		assert!(url.starts_with("data:image/png;base64,"));
	}

	#[test]
	fn translate_response_builds_content_blocks_and_usage() {
		let resp = translate_response(
			&json!({
				"id": "chatcmpl-1",
				"choices": [{
					"message": { "content": "hello", "role": "assistant" },
					"finish_reason": "stop",
				}],
				"usage": { "prompt_tokens": 10, "completion_tokens": 4 },
			}),
			"req-model",
		);
		assert_eq!(resp["type"], json!("message"));
		assert_eq!(resp["model"], json!("req-model"));
		assert_eq!(resp["content"][0]["text"], json!("hello"));
		assert_eq!(resp["stop_reason"], json!("end_turn"));
		assert_eq!(resp["usage"]["input_tokens"], json!(10));
		assert_eq!(resp["usage"]["output_tokens"], json!(4));
	}

	#[test]
	fn translate_response_maps_tool_calls_into_tool_use_blocks() {
		let resp = translate_response(
			&json!({
				"choices": [{
					"message": {
						"content": null,
						"tool_calls": [{
							"id": "t1",
							"function": { "name": "f", "arguments": "{\"a\":1}" },
						}],
					},
					"finish_reason": "tool_calls",
				}],
				"usage": {},
			}),
			"m",
		);
		assert_eq!(resp["stop_reason"], json!("tool_use"));
		let block = &resp["content"][0];
		assert_eq!(block["type"], json!("tool_use"));
		assert_eq!(block["name"], json!("f"));
		assert_eq!(block["input"]["a"], json!(1));
	}

	#[test]
	fn sse_translator_streams_text_and_closes_out() {
		let mut t = SseTranslator::new("m");
		let e1 = t.feed(r#"{"id":"1","choices":[{"delta":{"content":"hel"}}],"usage":{"prompt_tokens":5}}"#);
		assert!(e1.iter().any(|e| e.starts_with("event: message_start")));
		assert!(e1.iter().any(|e| e.contains("content_block_start")));
		let e2 = t.feed(r#"{"id":"1","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}"#);
		assert!(e2.iter().any(|e| e.contains("content_block_delta")));
		assert!(e2.iter().any(|e| e.contains("message_delta")));
		assert!(t.finished());
		assert!(t.close().is_empty());
	}

	#[test]
	fn sse_translator_handles_done_token_and_non_json_keepalive() {
		let mut t = SseTranslator::new("m");
		assert!(t.feed(": ping").is_empty());
		let done = t.feed("[DONE]");
		assert!(done.iter().any(|e| e.contains("message_stop")));
		assert!(t.finished());
	}

	#[tokio::test]
	async fn count_tokens_estimates_from_system_messages_and_tools() {
		let resp = crate::anthropic::count_tokens(Bytes::from(
			serde_json::to_vec(&json!({
				"system": "abcdefgh",
				"messages": [{ "role": "user", "content": "xyz" }],
				"tools": [{ "name": "t" }],
			}))
			.unwrap(),
		))
		.await;
		assert_eq!(resp.status().as_u16(), 200);
	}
}
