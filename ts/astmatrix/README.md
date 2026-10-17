# @flock/astmatrix

AST Matrix cloud router — a **Go→TypeScript live conversion** of
`herd/internal/astmatrix` (3,912 lines of Go), running as a Bun sidecar
inside the Flock repository.

## What it is

The full behavioral port of the AST Matrix: provider catalog wiring,
strategies (hybrid, ast_race, sticky_affinity, weighted_elo,
circuit_chain, fifo_matrix, free), request racing with AST-first
selection, ELO scoring, circuit breakers, per-provider rate limiting with
exponential backoff + jitter, SQLite health DB, sticky sessions, and the
self-contained dashboard UI.

## What it is not

- **Not a reimplementation of the catalog.** `providers_generated.go`
  (the generated Go artifact) is NOT ported. The catalog's source of
  truth is `@ranch/roost` (`mesh/catalog/`); this package imports it
  directly. Provider definitions, seeds, aliases, and dead IDs all come
  live from Roost.
- **Not the discovery brain.** Roost owns discovery, quarantine, and the
  live catalog file. This package only *reads* the answer via
  `LiveCatalogReader` (contract `ranch-roost/live-catalog/v1`), exactly
  like the Go `liveCatalogReader`.

## Layout

```
src/
  config.ts        AstMatrixConfig + defaults (port of config.go)
  healthdb.ts      SQLite health DB via bun:sqlite (port of healthdb.go)
  live-catalog.ts  live catalog file reader + serve-404 reporting
  matrix.ts        ELO / circuits / sticky / rate limiter / pickWeighted
  providers.ts     Tack-driven provider table, aliases, resolveModel, isAST
  ratelimit.ts     per-provider rate limiter w/ exponential backoff
  registry.ts      extended provider registry (9Router-derived, hand-maintained)
  router.ts        Router: strategies, racing, callOne, HTTP handling
  ui.ts            self-contained dashboard HTML
  server.ts        Bun sidecar entrypoint (HTTP on $ASTMATRIX_PORT, default 25214)
  index.ts         public exports
tests/             bun:test ports of the Go test files + Tack integration tests
```

## Running

```sh
bun install
bun test            # 61 tests
bun run typecheck   # tsc --noEmit
ASTMATRIX_PORT=25214 bun ./src/server.ts
```

Endpoints: `GET /health`, `GET /v1/models`, `POST /v1/chat/completions`
(OpenAI-compatible), `GET /ui`, `GET /ui/data`,
`POST /admin/sync-catalog`.

## Deployment contract (sidecar)

The Rust flock proxy (`mesh/proxy/flock-proxy`, `:25193` retired 2026-10-02 —
preserved, not live) was designed to route cloud-model requests to this
sidecar over localhost HTTP, replacing the embedded Go ASTMatrix in herd.
stays untouched — removal happens only after the sidecar is deployed,
supervised, and verified end-to-end.

- `estate-scripts_LIVE_CATALOG` — live catalog file path
  (default `/home/toxic/estate/.state/provider-catalog.live.json`)
- `estate-scripts_CATALOG_404_URL` — Roost's serve-404 intake
  (default `http://127.0.0.1:25200/admin/catalog/serve-404`)
- `ASTMATRIX_STRATEGY` — default routing strategy (default `hybrid`)

## Porting notes (Go → Bun)

- `sync.RWMutex` elided everywhere: Bun is single-threaded.
- `http.ResponseWriter` handlers became `handleRequest(req): Promise<Response>`.
- Goroutine fan-out + `WaitGroup` became `Promise.allSettled` with a
  95s `AbortController` ceiling (mirrors the Go timeout).
- Streaming responses became `Response(ReadableStream)` with SSE headers.
- `go reportServe404(...)` became a fire-and-forget promise.
- The extended registry merges in deterministic sorted order; core
  (Roost) wins on collision; non-`openai` formats and empty base URLs
  are skipped — exactly like the Go.
