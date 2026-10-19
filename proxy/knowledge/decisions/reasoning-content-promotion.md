---
type: Decision
title: Promote reasoning text into empty content on buffered chat completions
description: When a buffered chat-completion choice has empty/null content but non-blank reasoning_content or reasoning, the proxy fills content with that text on the wire (config-gated, on by default). This is the master fix for the 2026-10-19 empty-response disease: per-caller extraction fallbacks are whack-a-mole; normalization belongs in hodos.
tags: [wire-format, reasoning-content, empty-response, chat-completions]
timestamp: 2026-10-19T00:00:00Z
---

# Promote reasoning text into empty `content` on buffered chat completions

## Context

Reasoning-heavy models on NVIDIA NIM (and other routes) intermittently emit
chat completions with `finish_reason: length`, `content: null`, and the
actual generated text in `reasoning_content` (or a bare `reasoning` field).
Clients that read only `content` see an empty completion — the "empty-response
disease" (2026-10-19). Per-caller patches (`bidder.py`/`oracle_ask.py`
extraction fallbacks `5d0d9de`, corral `nimProxy` `c9710c1`, react-loop
bounded reads) are whack-a-mole: every consumer must independently
re-discover the extraction. The normalization belongs on the wire, in hodos,
once.

The proxy already inspects buffered chat-completion bodies: the
empty-completion substance guard (`observation::has_substance`) treats a
reasoning-only choice as *substantive* — it is real output, not an empty
completion. But the body passed through with `content: null` untouched, so
`content`-only clients still starved.

## Options

1. **Do nothing in hodos** — keep pushing per-caller extraction fallbacks.
   Every new caller re-discovers the disease; the wire keeps lying.
2. **Promote on the wire, buffered path** — when a buffered chat-completion
   choice has blank/null `content` and non-blank `reasoning_content` (or
   `reasoning`), copy that text into `content`, leaving the reasoning fields
   in place. Fill, never move; never overwrite real content; never touch
   tool-call choices.
3. **Promote on streaming SSE too** — rewrite `delta.reasoning_content`
   events mid-stream into `delta.content` events. Requires live event
   rewriting on the zero-copy streaming path; breaks the passthrough
   latency contract and complicates the heartbeat/failover machinery.

## Choice

Option 2, config-gated by `limits.promote_reasoning_content`, **default ON**.

- Default on because the disease is the common failure and callers already
  assume it: every production consumer extracts
  `content|reasoning_content|reasoning`. The proxy converging the wire to
  that assumption removes a class of bug instead of papering over it.
  `strict_passthrough: true` users and anyone needing byte-identical relay
  set the gate off explicitly.
- Insertion point is the buffered path only (`RouterHandle::execute_buffered`
  → `observation::promote_reasoning_content`), after the substance guard
  and before the body is packaged for the client or coalesced followers —
  so all consumers of a buffered reply heal at once.
- Streaming (`stream: true`) stays a zero-copy SSE passthrough. SSE deltas
  carry `reasoning_content` events untouched; streaming consumers keep
  their existing delta extraction. Mid-stream rewriting (option 3) is a
  known gap, deliberately deferred: it would trade the latency contract
  for a cosmetic fix.
- `None` return = zero-copy passthrough for the common case: the body is
  re-serialized only when a choice actually changed.

## Wire-format note

Per invariant 4 ("the wire format does not move") this is an intentional,
documented change: response bodies on buffered chat completions may now
contain `content` where the upstream sent `content: null`. Reasoning fields
are preserved verbatim; nothing else in the envelope moves. Shipped with
unit tests, an end-to-end gate test, and this release note.

## Consequences

- `content`-only clients stop seeing empty completions from reasoning-heavy
  models; existing `content|reasoning_content|reasoning` fallbacks keep
  working unchanged (they read the same value twice).
- Byte-identical-relay users must set
  `limits.promote_reasoning_content: false` (or `strict_passthrough`).
- Metrics/observations are unaffected: `observe_buffered` inspects the
  body the same way; the observer counts reasoning tokens as before.
