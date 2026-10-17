# Flock Maximal Merge — Pattern Absorption Record

**Date:** 2026-09-30
**Agent:** Anvil (maximal-flock-merge lane)
**Base:** Phase 2 commit 952a9da

This document records what was borrowed from each of the six source routers,
what was left behind, and why. The goal: flock becomes the one maximal router
by absorbing worth-keeping patterns, not by deleting the others.

## Phase A: fastllm-proxy — Context-Window Auto-Demotion

**Source:** `Fastllm-proxy/src/routing.rs` (~line 1170)

**Pattern:** When a request needs N tokens (prompt + max_tokens), models whose
declared context window cannot hold N are demoted (not dropped) to the back
of the candidate chain via stable sort. Undeclared windows are never demoted.

**Taken:**
- `needed_tokens()` = estimated prompt tokens (chars/4) + max_tokens
- Stable-sort demotion in `select_with_budget()`
- `context_lengths: BTreeMap<String, u64>` on ProviderDef
- Roost seeds context windows for 17 providers

**Left:** fastllm's routing table structure (flock's strategy system is superior).

**Commit:** 75e9a31

## Phase B: AstrLink — Routing Decision Records

**Source:** `AstrLink/core/contract/routing_decision.go`

**Pattern:** Every routing decision produces a structured record explaining
WHY a provider was chosen and which were skipped, bounded at 64 skips.

**Taken:**
- `decision.rs`: `SelectionReason` (6 variants), `SkipReason` (12 variants)
- `RoutingDecision` with bounded `push_skip()`, `validate()`
- `select_with_decision()` returns `(candidates, decision)`
- `execute()` emits decision as structured tracing event

**Left:** WS-specific reasons kept as variants but not populated (flock doesn't
do WS routing yet). Header deferred.

**Commit:** 75a86f7

## Phase C: BrighTO_Router — Overhead Header

**Source:** `BrighTO_Router/src/proxy/mod.rs:1034`

**Pattern:** `x-router-overhead-ms` response header measuring ingress→dispatch.

**Taken:** Header in `relay()` using `Ctx.started.elapsed()`.

**Left:** `BackendLease` RAII — flock already has scopeguard equivalent.

**Commit:** 7a6c2b5

## Phase D: modelmux + GenPark — Attempts Ledger (DONE)

**Status:** Done (commit a37a9b1). `RoutingDecision` gains a bounded
per-attempt ledger (`attempts: Vec<RoutingAttempt>`, provider + status +
latency_ms, 0 = connection failure), capped at `MAX_ROUTING_ATTEMPTS=64`
mirroring the skips bound. `execute_buffered` records every upstream
attempt (connection failure, retryable, empty-completion failover,
success); the streaming retry loop does the same. A `DecisionEmit`
drop-guard emits the completed decision (selection + skips + attempts)
as a structured tracing event on every exit path, panics included.
Admission rejections (rate-limited / circuit-open) are not attempts —
the ledger records actual upstream sends only.

## Phase E: Streaming Commit + Probe Isolation (DONE)

**Status:** Done (commit a37a9b1). Two gaps found and fixed:

1. **Probe isolation:** `CircuitBreaker::allow()` admitted unlimited
   concurrent half-open probes despite the "a half-open trial consumes
   the trial" comment at the call site. GenPark single-probe isolation
   is now literal: exactly one in-flight probe while half-open,
   concurrent callers fail fast / fail over. `record_success` /
   `record_failure` release the lease; new `release_probe()` covers
   admitted-but-never-sent probes (wired into `acquire()`'s early
   returns: rate-limited, deadline, client-gone, governor reject).
   `restore()` leaves the lease clear. Stale "3 half-open successes"
   docstrings corrected to 2 (the GenPark-corrected default).
2. **Streaming commit:** pre-first-byte retries already existed; the
   missing piece was the stall arm, which errored instead of retrying
   before the first chunk. Now: a stalled upstream with no chunk yet
   (and deadline not exceeded) retries the outer loop — the retry
   window stays open until commit. Once the first chunk flows, the
   response is committed and stalls error as before. Explicit
   `flock_stream_commit_total` counter at first chunk. The
   `Unavailable` arm of `execute_buffered` yields 50 ms so half-open
   siblings rejected by probe isolation don't hot-spin the loop.

## Phase F: VansRouter — Provider Model Audit (DONE)

**Status:** Done (commit a37a9b1). VansRouter uses subscription-OAuth
(not API-key), so providers don't map — but its model IDs were current
and 9 were missing from Roost `data.ts`. Added as data-only seeds
(none were in `DEAD_MODEL_IDS`):

- anthropic: `claude-opus-4-5-20251101`, `claude-sonnet-4-5-20250929`
- openai: `gpt-5.2-codex`, `gpt-5.1-codex-max`
- google: `models/gemini-3-flash-preview`, `models/gemini-3-pro-preview`
- moonshot: `kimi-k2-thinking`
- deepseek: `deepseek-v3.2-chat`
- new `dashscope` provider def (Alibaba,
  `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`,
  `DASHSCOPE_API_KEY`, openai adapter): `qwen3-coder-plus`,
  `qwen3-coder-flash`

Regenerated `providers.go` / `providers.json` / `providers.rs` via
`bun run build`, re-synced the herd consumer copy
(`herd/internal/astmatrix/providers_generated.go`) and the proxy's
`roost_providers.rs` (sanctioned sync script).

## Summary

| Phase | Source | Status | Commit |
|-------|--------|--------|--------|
| A | fastllm-proxy | Done | 75e9a31 |
| B | AstrLink | Done | 75a86f7 |
| C | BrighTO_Router | Done | 7a6c2b5 |
| D | modelmux/GenPark | Done | a37a9b1 |
| E | modelmux | Done | a37a9b1 |
| F | VansRouter | Done | a37a9b1 |

**Tests:** `cargo test` 129 passed + 1 ignored, 0 failed (8 new:
attempts ledger bounds/serialization, single-probe isolation, lease
release, restore-clears-lease); roost `bun test` 69/69.