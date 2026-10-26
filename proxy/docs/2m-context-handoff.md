# 2M-context handoff experiment (2026-10-26)

## Premise under test

bodybuilder should auto-select the BEST model that keeps a large (→2M) context
across model switches, using the KV/GPU/nvme-backed context machinery.

## Live canary against the deployed gateway (:25193, release binary)

1. `~7.5 MB` payload (≈1.28M parsed tokens, 2M-token-class prompt) with
   `model: "auto"` → **accepted past the 64MB body limit** (`lib.rs:790
DefaultBodyLimit::max(64MB)` — a true 2M-token context ≈8MB fits).
2. Provider responded:
   `400 {"error":{"message":"This model's maximum context length is 1048576
tokens. However, your messages resulted in 1280909 tokens..."}}`

## Finding: the routing layer does NOT gate selection by context budget

The `auto` directive resolved to a **1M-window provider** (nemotron-ultra /
lightning class) for a 1.28M-token job. `select_with_budget`'s
`context_window_demotion` only _demotes-to-back_ (never drops) providers whose
declared window `< needed`, and:

- `context_lengths` is keyed by the **declared upstream model id**, which for
  `auto` is the first `model_map["auto"]` entry — a mismatch with the budget
  keyed on the prompt.
- `auto` → `Strategy::Free` filters to free-tier providers; a 2M-window
  provider (`grok-4.5/4.6`, declared 2,000,000 in mimetite `resolveContext`)
  may not be free-tier, leaving only the 1M provider → forwarded anyway → 400.

## Required fix (premise-completion)

Selection must make context budget a **hard gate**, not a demote**: a provider
whose resolved `context_window(model) < needed_tokens(body)` must be dropped
from candidates (not merely demoted) when a larger-window provider exists, so a
2M job always lands on a 2M-capable model. Tie the demotion key to the resolved
context window (`resolveContext`) rather than the first `model_map` entry, and
let `auto` prefer the largest window that fits (free-tier-aware).

## Artifacts

- `resolveContext` 2M contract test: `mimetite/tests/data.test.ts`
  (`grok-4.5/4.6 -> 2_000_000`, nemotron-ultra/lightning -> 1_048_576).
- router mock-upstream integration: `router.rs` `execute_buffered...` tests.
- coverage: rhodochrosite lib 75.8% -> 81.6% lines (353 green).
