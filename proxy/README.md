# hodos

A multi-provider OpenAI/Anthropic-compatible proxy that never violates an
upstream provider's speed limit. Hodos fronts every model the estate can
reach — NVIDIA NIM, Groq, Cerebras, Together, Mistral, OpenRouter, SiliconFlow,
Google-EAP, free-inference — behind one OpenAI-compatible
(`/v1/chat/completions`) and Anthropic-Compat (`/v1/messages`) surface, pacing
every request through a per-key token bucket + FIFO, load-balancing across
providers by an 8-strategy router, keeping client connections alive while they
wait, and ride-outing 429/5xx with `Retry-After` honored and per-provider
circuit breakers.

It is a single Rust binary (`src/main.rs` is a shim over `src/lib.rs::run()`).

> This README is rebuilt from the source. The previous README described only
> the old single-NVIDIA path; the code has since become a full multi-provider
> router. **Source modules are the authority** — see the module map at the
> bottom and the `AGENTS.md` invariants.

## What hodos actually is

Request lifecycle (from `knowledge/architecture/index.md`, verified against
`src/proxy.rs`, `src/router.rs`, `src/route.rs`):

```
client
  -> [client auth]                src/proxy.rs (Bearer SHA-256, or keyed-client)
  -> [route select]               src/router.rs (8 strategies)
  -> [provider admission]         circuit -> token bucket -> governor -> FIFO
  -> [upstream]                   provider base URL + path, model rewritten
  -> [streaming pipeline]         saves the client connection while waiting
```

Unlike the old README's "strict pass-through to NIM", the code is a
**multi-provider router** (`RouterInner` in `router.rs`). There is no single
`upstream` in the current config schema (`config.rs` version is `2`); instead a
registry of `ProviderDef`s owns the fleet, each with its own pool, dispatcher,
governor, circuit, and coalescer.

## Invariants (from `AGENTS.md`, non-negotiable)

1. **Fail closed.** Pre-setup the data plane is shut; post-setup every operator
   surface requires a session; a corrupt/future-version config/auth store
   refuses to boot.
2. **Zero upstream rate violations.** Not "few". The proxy exists to never
   exceed the per-key limit.
3. **The wire format does not move.** API bodies, status codes, content types,
   OpenAPI, config/history formats, metric names and label values are
   protected machine contracts. A breaking change needs a decision + tests +
   release note.
4. **Data is never localized.** Model ids, client names, publisher names, and
   every `hodos_*` series pass through untouched.
5. **Identifiers stay frozen** during label-only work.
6. **Context owns the sink** (CSP + escaping discipline on the dashboard).

## Provider routing

Every provider has a `ProviderDef` (`providers.rs`): a stable `name`, `base_url`,
`AuthScheme` (ApiKey | None), a list of `ProviderKey`s (each with per-key `rpm`,
`key_env` fallback), a `models` list, a `model_map` (upstream-id rewrite), `elo`,
`weight`, `free_tier`, `default_rpm`, and `context_lengths`.

Config-order routing (8 strategies, `Strategy::parse` names match AstMatrix so
Herd configs keep meaning them):

| Strategy           | Behavior                                                     |
| ------------------ | ------------------------------------------------------------ |
| `hybrid` (default) | candidates in order; healthy+latency first, then ELO         |
| `ast_race`         | fan out to every candidate, first usable wins (gated, fixed) |
| `sticky_affinity`  | prefer the pinned provider for a session                     |
| `weighted_elo`     | ELO-proportional random choice                               |
| `least_latency`    | lowest recent latency first                                  |
| `round_robin`      | atomic counter rotation                                      |
| `free`             | only free-tier providers (literal model `"free"` forces it)  |
| `circuit_chain`    | walk candidates until one returns usable                     |

`"auto"` is a routing directive (not a model name): it classifies the task from
the prompt text (`routing_intel.rs`) and picks the lane — code → ast race,
reasoning → hybrid, default → free-then-hybrid.

Per-attempt admission stack (`RouterHandle::acquire`, `router.rs`):
**[circuit] → [provider token bucket] → [model governor] → [FIFO slot]**.

- **Circuit breaker** — `CircuitBreaker::astmatrix_defaults()`: 5 failures /
  30 s / 3 half-open successes.
- **Token bucket** — `ratelimit.rs`, refills at rate, **per-provider** (tightest
  of enabled key RPM, else provider default, else 10 free / 60 paid).
- **Model governor** — `governor.rs`, worker-concurrency (not RPM); only tripped
  by worker-exhaustion errors; operator-pinned per-model caps.
- **FIFO dispatcher** — `dispatch.rs`, 25 ms grant spacing; lone candidate
  retries until deadline, several candidate rounds bounded by `max_retries`.

Retryable statuses are `429 | 500 | 502 | 503 | 504` (`router.rs::retryable_status`).
**A 4xx is the client's error**: relayed verbatim, never retried, never failed
over, never counted against the circuit. On a retryable status the provider is
recorded (circuit + lane cooldown, honoring upstream `Retry-After`) and the
request fails over to the next candidate.

Empty-completion substance guard: a 2xx chat completion with no content and no
tool calls on `/v1/chat/completions` is a **failure** (strikes provider/model,
fails over, honest 502 when every candidate is empty).

`promote_reasoning_content` (2026-10-19): a buffered reply with empty `content`
but non-empty `reasoning_content`/`reasoning` gets its `content` filled from the
reasoning text before it's packaged for the client or coalesced followers.

## HTTP surface (`src/routes.rs`, generated OpenAPI)

Auth is split by surface:

- **Client-facing** (`/v1/*`, `/api/client/*`, `/api/pricing/*`) — keyed by a
  Bearer client key (SHA-256 digest, shown once at creation; fail-closed when
  zero keys). `/v1/{*path}` is the OpenAI-compat proxy; `/v1/messages` +
  `/v1/messages/count_tokens` are Anthropic-compat; `/v1/custom/bodybuilder` and
  `/v1/bodybuilder` are the body-rewrite utility.
- **Operator-facing** (`/`, `/dash`, `/metrics`, `/api/*`) — session cookie
  (PBKDF2-SHA256 600k-iter, constant-time compare, password-fragment-bound
  sessions that invalidate on password change).

Public: `/health`, `/login`, `/logout`, `/setup` (wizard when no superuser),
`/api/locale-bootstrap`.

Dashboard API bytes are **declaration-order = wire-order** (`api.rs`); every
JSON endpoint answers failures with one envelope `{"error": {"code", "message",
"type":"proxy_error"}}` — the same shape `/v1` uses.

## Observability

- `/metrics` — Prometheus exposition (bounded label cardinality; model labels
  beyond a cap collapse to `other`).
- `/api/dashboard`, `/api/dashboard/now` — rolled-up history, live registry
  values + the config they were sampled under.
- `src/history.rs` — SQLite-backed telemetry rollups (config store double as
  save-mutex), `history-revision` in responses.
- Routing decision records (`decision.rs`): why a provider was chosen, what was
  skipped and why (structured tracing; `AstrLink` pattern).

Env (container-level only): `HOST`, `PORT`, `DATA_DIR`, `RUST_LOG`,
`TRUST_PROXY`. Everything else — providers, keys, routing, limits, users,
history — lives in `DATA_DIR/config.json` (version 2, migrated from v1) and is
managed through the settings API. Legacy env (`NIM_API_KEYS`, `NIM_BASE_URL`,
`RPM_PER_KEY`, `PROXY_API_KEYS`, …) is read only once and warned on: those
settings now live in the dashboard.

## Build & health

- `hodos --health` probes own `/health` (for HEALTHCHECK on a scratch image
  with no shell/curl).
- Tests are extensive in-tree; before merge: `cargo fmt --check` plus the named
  proof in `knowledge/testing/test-strategy.md`.

## Module map (src/, all the source)

| file                                        | role                                                         |
| ------------------------------------------- | ------------------------------------------------------------ |
| `lib.rs`                                    | app state, config snapshot, router wiring, `run()` entry     |
| `routes.rs`                                 | fixed route paths + test-only contract inventory             |
| `proxy.rs`                                  | `/v1` request handling (deadline header, pacing, streaming)  |
| `router.rs`                                 | the multi-provider router: strategies, admission, failover   |
| `providers.rs`                              | provider/model/key schema + 13 seeded provider registry      |
| `pinax_providers.rs` / `roost_providers.rs` | provider-detail registries                                   |
| `ratelimit.rs`                              | per-provider token bucket                                    |
| `dispatch.rs`                               | FIFO slot dispatcher (25 ms grant spacing)                   |
| `pool.rs`                                   | per-key lane pool, 61 s sliding windows                      |
| `governor.rs`                               | per-model worker-concurrency governor                        |
| `circuit.rs`                                | circuit breaker (5/30/3)                                     |
| `coalescer.rs`                              | identical in-flight buffered-request coalescing (5 s TTL)    |
| `anthropic.rs`                              | Anthropic-messages surface                                   |
| `bodybuilder.rs`                            | request/response body rewrite utility                        |
| `observation.rs`                            | streaming pipeline + usage observation metrics               |
| `decision.rs`                               | routing-decision record (why chosen, why skipped)            |
| `routing_intel.rs`                          | `"auto"` lane classification from prompt text                |
| `health.rs`                                 | health/ELO/latency DB + state persistence to SQLite          |
| `history.rs`                                | telemetry history rollups                                    |
| `config.rs`                                 | the persisted config store (v2)                              |
| `auth.rs`                                   | operator sessions (PBKDF2, throttle) + client-key primitives |
| `settings.rs`                               | the settings API handlers                                    |
| `api.rs`                                    | typed dashboard/API wire format + generated OpenAPI          |
| `client_api.rs`                             | key-gated client endpoints (`/api/health/ping`, pricing)     |
| `dots.rs`, `presentation.rs`                | dashboard surface                                            |
| `main.rs`                                   | thin shim calling `lib.rs::run()`                            |
