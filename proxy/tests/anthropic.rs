//! Anthropic Messages surface regression tests.
//!
//! Red→green: these fail without `src/anthropic.rs` (no translation
//! functions, no `/v1/messages` route) and pass once the shim is wired.

use rhodochrosite::anthropic::{SseTranslator, translate_request, translate_response};
use serde_json::{Value, json};

#[test]
fn system_string_becomes_system_message() {
	let body = json!({
		 "model": "claude-sonnet-5",
		 "max_tokens": 64,
		 "system": "be terse",
		 "messages": [{ "role": "user", "content": "hi" }],
	});
	let out = translate_request(&body).expect("translates");
	assert_eq!(out["messages"][0]["role"], "system");
	assert_eq!(out["messages"][0]["content"], "be terse");
	assert_eq!(out["messages"][1]["role"], "user");
	assert_eq!(out["messages"][1]["content"], "hi");
	// claude-* model ids map onto the verified default, not a NIM 404.
	assert!(!out["model"].as_str().unwrap_or("").starts_with("claude"));
}

#[test]
fn tool_round_trip() {
	let body = json!({
		 "model": "claude-sonnet-5",
		 "max_tokens": 128,
		 "tools": [{
			  "name": "get_weather",
			  "description": "Weather lookup",
			  "input_schema": { "type": "object", "properties": { "city": { "type": "string" } } },
		 }],
		 "tool_choice": { "type": "tool", "name": "get_weather" },
		 "messages": [
			  { "role": "user", "content": "weather in Paris?" },
			  { "role": "assistant", "content": [
					{ "type": "tool_use", "id": "call_9", "name": "get_weather", "input": { "city": "Paris" } }
			  ]},
			  { "role": "user", "content": [
					{ "type": "tool_result", "tool_use_id": "call_9", "content": "22C" }
			  ]},
		 ],
	});
	let out = translate_request(&body).expect("translates");
	assert_eq!(out["tools"][0]["type"], "function");
	assert_eq!(out["tools"][0]["function"]["name"], "get_weather");
	assert_eq!(out["tool_choice"]["function"]["name"], "get_weather");
	// assistant tool_use → tool_calls
	let assistant = out["messages"]
		.as_array()
		.unwrap()
		.iter()
		.find(|m| m["role"] == "assistant")
		.unwrap();
	assert_eq!(assistant["tool_calls"][0]["id"], "call_9");
	let args = assistant["tool_calls"][0]["function"]["arguments"]
		.as_str()
		.unwrap();
	assert!(serde_json::from_str::<Value>(args).is_ok());
	// user tool_result → role:tool
	let tool = out["messages"]
		.as_array()
		.unwrap()
		.iter()
		.find(|m| m["role"] == "tool")
		.unwrap();
	assert_eq!(tool["tool_call_id"], "call_9");
	assert_eq!(tool["content"], "22C");
}

#[test]
fn response_shape_and_stop_reason() {
	let openai = json!({
		 "id": "chatcmpl-1",
		 "choices": [{
			  "finish_reason": "tool_calls",
			  "message": {
					"role": "assistant",
					"content": null,
					"tool_calls": [{
						 "id": "call_1",
						 "type": "function",
						 "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" }
					}]
			  }
		 }],
		 "usage": { "prompt_tokens": 12, "completion_tokens": 5 },
	});
	let out = translate_response(&openai, "claude-sonnet-5");
	assert_eq!(out["type"], "message");
	assert_eq!(out["role"], "assistant");
	assert_eq!(out["stop_reason"], "tool_use");
	let blocks = out["content"].as_array().unwrap();
	let tool = blocks
		.iter()
		.find(|b| b["type"] == "tool_use")
		.expect("tool_use block");
	assert_eq!(tool["name"], "get_weather");
	assert_eq!(tool["input"]["city"], "Paris");
	assert_eq!(out["usage"]["input_tokens"], 12);
	assert_eq!(out["usage"]["output_tokens"], 5);
}

#[test]
fn sse_stream_grammar() {
	let mut t = SseTranslator::new("claude-sonnet-5");
	let mut all = String::new();
	for chunk in [
		json!({"id":"c1","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}).to_string(),
		json!({"choices":[{"delta":{"content":"lo"}}]}).to_string(),
		json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":2}})
			.to_string(),
		"[DONE]".to_string(),
	] {
		for event in t.feed(&chunk) {
			all.push_str(&event);
		}
	}
	assert!(t.finished());
	assert!(all.contains("event: message_start"));
	assert!(all.contains("event: content_block_start"));
	assert!(all.contains("event: content_block_delta"));
	assert!(all.contains("\"text\":\"Hel\""));
	assert!(all.contains("\"text\":\"lo\""));
	assert!(all.contains("event: content_block_stop"));
	assert!(all.contains("event: message_delta"));
	assert!(all.contains("\"stop_reason\":\"end_turn\""));
	assert!(all.contains("event: message_stop"));
}

#[test]
fn sse_tool_stream_uses_input_json_delta() {
	let mut t = SseTranslator::new("m");
	let mut all = String::new();
	for chunk in [
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_weather","arguments":"{\"ci"}}]}}]}).to_string(),
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\":\"Paris\"}"}}]},"finish_reason":"tool_calls"}]}).to_string(),
    ] {
        for event in t.feed(&chunk) {
            all.push_str(&event);
        }
    }
	assert!(all.contains("\"type\":\"tool_use\""));
	assert!(all.contains("input_json_delta"));
	assert!(all.contains("\"stop_reason\":\"tool_use\""));
}

#[test]
fn route_contract_includes_anthropic_surface() {
	// The route-contract inventory lives behind the routes module's own
	// reconciling tests; here we pin the two paths exist in source form.
	let src = include_str!("../src/routes.rs");
	assert!(src.contains("pub const V1_MESSAGES: &str = \"/v1/messages\";"));
	assert!(
		src.contains("pub const V1_MESSAGES_COUNT_TOKENS: &str = \"/v1/messages/count_tokens\";")
	);
}
