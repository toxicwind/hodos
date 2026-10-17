# @flock/bench

Reusable provider benchmark runner, ported from estate-scripts-router's
`provider-bench.ts`. For each configured model on a provider it measures:

1. **liveness** — one real completion, semantic-failure aware (empty output
   or refusal markers = unhealthy)
2. **quality** — N deterministic instruction-following requests on the 0–2
   sentinel scale (exact match = 2, contains = 1, else 0), comparable with
   the GuideLLM ranking-eval priors
3. **latency** — per-request ms, p50 reported

Provider definitions and model lists come from the **Roost package**
(`../../roost/src`) — the same catalog the strategy tier routes against —
instead of a divergent static list. `servingModels()` (live discovery ∪
seeds, minus quarantine/dead) is the bench population. `herd`,
`kimi-auto`, and `openrouter` are deliberately excluded (local compute not
for tasks; Moonshot billing; GuideLLM priors already exist) — see
`BENCH_EXCLUDE`.

## Doctrine

- fail-fast: per-request timeout, NO retries. A 429/401/timeout is DATA,
  never a retry signal.
- 429 stops the provider; 401/403 marks the key dead. Both stop conditions
  short-circuit the remaining models.
- Keys never leave the box: reads KEY_ENV at runtime; run ON yote where
  `~/.secrets` is sourced. Pool envs (e.g. `NVIDIA_API_KEYS`) resolve
  pool-first, first non-empty key wins — same as the router.

## Usage

```bash
bun ./bench.ts run --provider groq [--models a,b] [--reqs 3] \
    [--concurrency 2] [--timeout-ms 45000] [--out-dir bench-runs]
bun ./bench.ts catalog --provider groq   # list live /models ids
bun ./bench.ts list                      # show past runs
bun ./bench.ts providers                 # configured providers + models
```

Output: `bench-runs/<ts>-<provider>.json` — full evidence per model (http
status, latency_ms per request, quality scores, liveness verdict).

## API

`runProvider(provider, opts, defs?)`, `catalogModels(provider, defs?)`,
`benchDefs(catalog?)`, `scoreQuality`, `livenessVerdict`, `p50`,
`resolveKey`. The library functions take an optional defs record so tests
can inject fixtures without touching the network.

Tests: `bun test ./bench.test.ts`
