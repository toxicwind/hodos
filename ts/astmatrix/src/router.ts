/**
 * astmatrix-ts — cloud router: strategies, racing, failover.
 * Port of herd/internal/astmatrix/router.go (Go) to Bun/TypeScript.
 *
 * Adaptation notes (Go -> Bun):
 * - ServeHTTP(w, req) becomes handleRequest(req): Promise<Response>.
 * - Goroutine fan-out + WaitGroup becomes Promise.allSettled with an
 *   AbortController ceiling (95s, mirroring the Go timeout).
 * - Streaming responses become Response(ReadableStream) with SSE headers.
 * - `go reportServe404(...)` becomes a fire-and-forget promise.
 */
import {
  defaultConfig,
  type AstMatrixConfig,
} from "./config.ts";
import { Matrix, firstModelFor } from "./matrix.ts";
import {
  isAST,
  isExplicit,
  resolveModel,
} from "./providers.ts";
import { reportServe404 } from "./live-catalog.ts";

export interface RouteResult {
  ok: boolean;
  status: number;
  provider: string;
  model: string;
  lat: number;
  data?: Uint8Array;
  stream?: ReadableStream<Uint8Array>;
  err: string;
  winner: number;
}

type StrategyFn = (
  m: Matrix,
  body: Record<string, unknown>,
  session: string,
  signal?: AbortSignal,
) => Promise<RouteResult>;

/** Wraps Matrix and routes OpenAI-compatible chat requests to providers. */
export class Router {
  private config: AstMatrixConfig;
  private matrix: Matrix;

  private constructor(cfg: AstMatrixConfig, m: Matrix) {
    this.config = cfg;
    this.matrix = m;
  }

  static create(cfg: Partial<AstMatrixConfig> = {}): Router {
    const full = defaultConfig(cfg);
    return new Router(full, Matrix.create(full));
  }

  getMatrix(): Matrix {
    return this.matrix;
  }

  getConfig(): AstMatrixConfig {
    return this.config;
  }

  /**
   * Whether this router can serve the model: cloud model IDs that
   * resolve via coding aliases or provider model lists — NOT local GGUF
   * IDs (local dispatch takes priority upstream).
   */
  handles(model: string): boolean {
    if (!model) return false;
    if (model === "auto" || model === "fcm" || model === "free") return true;
    if (isExplicit(model)) return true;
    for (const p of Object.values(this.matrix.providers)) {
      if (p.models.includes(model)) return true;
    }
    return false;
  }

  /** Route an incoming OpenAI-compatible chat request. */
  async handleRequest(req: Request): Promise<Response> {
    let bodyMap: Record<string, unknown>;
    try {
      bodyMap = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError("invalid JSON body", 400);
    }

    const session = req.headers.get("X-Session-Id") || "default";
    const strategyName =
      req.headers.get("X-estate-scripts-Strategy") || this.config.strategy;
    const strategyFn = strategies[strategyName] ?? strategies["hybrid"];
    const stream = bodyMap["stream"] === true;

    const ctrl = new AbortController();
    const result = await strategyFn(this.matrix, bodyMap, session, ctrl.signal);

    if (stream && result.ok && result.stream) {
      return new Response(result.stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Routed-Via": result.provider,
          "X-Strategy": strategyName,
          "X-Latency": result.lat.toFixed(3),
        },
      });
    }

    if (!result.ok) {
      const errMsg = result.err || `routing failed: status ${result.status}`;
      return new Response(JSON.stringify({ error: errMsg }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "X-Routed-Via": result.provider,
        },
      });
    }

    return new Response(result.data, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Routed-Via": result.provider,
        "X-Strategy": strategyName,
        "X-Latency": result.lat.toFixed(3),
      },
    });
  }

  /** Snapshot for the dashboard / health endpoints. */
  uiData(): Record<string, unknown> {
    const summary = this.matrix.getHealth().providerSummary();
    const providers: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(this.matrix.providers)) {
      const freeModels = p.models.filter((mid) => mid.includes(":free"));
      providers[name] = {
        keyed: this.matrix.keyOk(name),
        circuit: this.matrix.circuitState(name),
        elo: Math.floor(this.matrix.eloOf(name) * 10) / 10,
        models: p.models.length,
        free_models: freeModels,
        health: summary[name] ?? null,
      };
    }
    return {
      router: "estate-scripts-router-ts",
      version: "v3.1",
      strategy: this.config.strategy,
      providers,
    };
  }

  close(): void {
    this.matrix.close();
  }
}

function jsonError(msg: string, status: number): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Single HTTP request to a provider; records the result in the matrix. */
async function callOne(
  m: Matrix,
  provider: string,
  model: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RouteResult> {
  if (!m.circuitOk(provider)) {
    return { ok: false, status: 503, provider, model: "", lat: 0, err: "circuit_open", winner: 0 };
  }

  const rl = m.getRateLimiter();
  if (!rl.canRequest(provider)) {
    const backoff = rl.getBackoffRemaining(provider);
    const errMsg =
      backoff > 0
        ? `rate_limited_by_router: retry after ${(backoff / 1000).toFixed(0)}s`
        : "rate_limited_by_router";
    m.record(model, provider, 429, 0, 0, "", "");
    return { ok: false, status: 429, provider, model: "", lat: 0, err: errMsg, winner: 0 };
  }

  const prov = m.providers[provider];
  if (!prov) {
    return { ok: false, status: 500, provider, model: "", lat: 0, err: "unknown_provider", winner: 0 };
  }

  const url = prov.base.replace(/\/+$/, "") + "/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "estate-scriptsASTMatrix/3.1",
    "Accept-Encoding": "identity",
  };
  if (!prov.noAuth) {
    headers["Authorization"] = "Bearer " + m.getKey(provider);
  } else {
    headers["Authorization"] = "Bearer <redacted>";
  }
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://zed.dev";
    headers["X-Title"] = "estate-scripts-AST-Matrix";
  }

  const stream = body["stream"] === true;
  const payload = { ...body, model, stream };
  let bodyBytes: string;
  try {
    bodyBytes = JSON.stringify(payload);
  } catch {
    return { ok: false, status: 500, provider, model: "", lat: 0, err: "marshal_error", winner: 0 };
  }

  const timeoutMs = stream ? 180_000 : 120_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const combined = anySignal(signal, ctrl.signal);

  rl.recordRequest(provider);
  const start = Date.now();
  let resp: Response;
  try {
    const req = new Request(url, {
      method: "POST",
      headers,
      body: bodyBytes,
      signal: combined,
    });
    // Forward selected incoming headers is the caller's job; fetch here.
    resp = await fetch(req);
  } catch (e) {
    clearTimeout(timer);
    const lat = (Date.now() - start) / 1000;
    m.record(model, provider, 500, lat, 0, "", "");
    return {
      ok: false, status: 500, provider, model: "", lat,
      err: e instanceof Error ? e.message : String(e), winner: 0,
    };
  }
  clearTimeout(timer);
  const lat = (Date.now() - start) / 1000;

  if (resp.status < 200 || resp.status >= 300) {
    const errBody = (await resp.text()).slice(0, 500);
    if (resp.status === 429) {
      const retryAfter = parseRetryAfterMs(resp.headers.get("Retry-After") ?? "");
      const rateLimitReset = parseRateLimitResetMs(resp.headers.get("X-RateLimit-Reset") ?? "");
      rl.record429(provider, Math.max(retryAfter, rateLimitReset));
    }
    m.record(model, provider, resp.status, lat, 0, "", "");
    if (resp.status === 404) {
      // Report to the TS catalog brain (best-effort, fire-and-forget).
      // Quarantine decision lives there; the live catalog file picks it up.
      void reportServe404(provider, model);
    }
    return { ok: false, status: resp.status, provider, model: "", lat, err: errBody, winner: 0 };
  }

  rl.recordSuccess(provider);

  if (stream) {
    m.record(model, provider, 200, lat, 0, "", "");
    return {
      ok: true, status: 200, provider, model, lat,
      stream: resp.body ?? undefined, err: "", winner: 0,
    };
  }

  let data: Uint8Array;
  try {
    data = new Uint8Array(await resp.arrayBuffer());
  } catch {
    m.record(model, provider, 500, lat, 0, "", "");
    return { ok: false, status: 500, provider, model: "", lat, err: "read_error", winner: 0 };
  }
  m.record(model, provider, 200, lat, 0, "", "");
  return { ok: true, status: 200, provider, model, lat, data, err: "", winner: 0 };
}

/** Combine two abort signals (either aborts the combined). */
function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (a.aborted || b.aborted) ctrl.abort();
  else {
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
  }
  return ctrl.signal;
}

// --- Strategies ---

async function routeHybrid(
  m: Matrix,
  body: Record<string, unknown>,
  session: string,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const model = getModel(body);
  if (isExplicit(model)) {
    const [p, mid] = resolveModel(model, m.providers);
    const r = await callOne(m, p, mid, body, signal);
    if (r.ok) {
      m.stickySet(session, p, mid);
      m.record(mid, p, 200, r.lat, 1, "hybrid_direct", session);
    }
    return r;
  }
  const [sp, sm0] = m.stickyGet(session);
  if (sp && m.keyOk(sp) && m.circuitOk(sp)) {
    const sm = sm0 || model;
    const r = await callOne(m, sp, sm, body, signal);
    if (r.ok) return r;
  }
  const r2 = await routeAstRace(m, body, session, signal);
  if (r2.ok) return r2;
  return routeCircuitChain(m, body, session, signal);
}

async function routeAstRace(
  m: Matrix,
  body: Record<string, unknown>,
  session: string,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const model = getModel(body);
  if (isExplicit(model)) {
    const [p, mid] = resolveModel(model, m.providers);
    const r = await callOne(m, p, mid, body, signal);
    if (r.ok) {
      m.stickySet(session, p, mid);
      m.record(mid, p, 200, r.lat, 1, "ast_race", session);
    }
    return r;
  }
  const cands = m.pickWeighted(m.getConfig().maxParallel);
  if (cands.length === 0) {
    return { ok: false, status: 503, provider: "", model: "", lat: 0, err: "no_providers", winner: 0 };
  }
  const results = await fanOut(m, cands, body, signal);
  let best: RouteResult | null = null;
  for (const r of results) {
    if (!r.ok) continue;
    if (r.data && r.data.length > 0) {
      const content = extractContent(r.data);
      if (content !== null && isAST(content)) {
        m.stickySet(session, r.provider, r.model);
        m.record(r.model, r.provider, 200, r.lat, 1, "ast_race", session);
        return r;
      }
    }
    if (!best) best = r;
  }
  if (best) {
    m.stickySet(session, best.provider, best.model);
    return best;
  }
  return { ok: false, status: 503, provider: "", model: "", lat: 0, err: "ast_race_exhausted", winner: 0 };
}

async function routeSticky(
  m: Matrix,
  body: Record<string, unknown>,
  session: string,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const model = getModel(body);
  if (isExplicit(model)) return routeAstRace(m, body, session, signal);
  const [sp, sm0] = m.stickyGet(session);
  if (sp && m.keyOk(sp) && m.circuitOk(sp)) {
    const sm = sm0 || model;
    const r = await callOne(m, sp, sm, body, signal);
    if (r.ok) return r;
  }
  return routeAstRace(m, body, session, signal);
}

async function routeWeighted(
  m: Matrix,
  body: Record<string, unknown>,
  session: string,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const cands = m.pickWeighted(1);
  if (cands.length === 0) {
    return { ok: false, status: 503, provider: "", model: "", lat: 0, err: "no_providers", winner: 0 };
  }
  const [p, mid] = cands[0];
  const r = await callOne(m, p, mid, body, signal);
  if (r.ok) m.stickySet(session, p, mid);
  return r;
}

async function routeCircuitChain(
  m: Matrix,
  body: Record<string, unknown>,
  session: string,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const model = getModel(body);
  if (isExplicit(model)) {
    const [p, mid] = resolveModel(model, m.providers);
    if (m.keyOk(p) && m.circuitOk(p)) {
      const r = await callOne(m, p, mid, body, signal);
      if (r.ok) m.stickySet(session, p, mid);
      return r;
    }
    return { ok: false, status: 502, provider: p, model: "", lat: 0, err: `explicit_provider_unavailable:${p}`, winner: 0 };
  }
  const all = Object.keys(m.providers)
    .map((name) => ({ name, score: m.eloOf(name) }))
    .sort((a, b) => b.score - a.score);
  for (const ps of all) {
    if (!m.keyOk(ps.name) || !m.circuitOk(ps.name)) continue;
    const mid = firstModelFor(ps.name, m.providers);
    if (!mid) continue;
    const r = await callOne(m, ps.name, mid, body, signal);
    if (r.ok) {
      m.stickySet(session, ps.name, mid);
      return r;
    }
  }
  return { ok: false, status: 503, provider: "", model: "", lat: 0, err: "circuit_chain_exhausted", winner: 0 };
}

async function routeFifo(
  m: Matrix,
  body: Record<string, unknown>,
  session: string,
  signal?: AbortSignal,
): Promise<RouteResult> {
  if (!m.fifoEnter()) {
    return { ok: false, status: 429, provider: "", model: "", lat: 0, err: "fifo_full", winner: 0 };
  }
  try {
    return await routeAstRace(m, body, session, signal);
  } finally {
    m.fifoExit();
  }
}

async function routeFree(
  m: Matrix,
  body: Record<string, unknown>,
  session: string,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const model = getModel(body);
  if (isExplicit(model)) {
    const [p, mid] = resolveModel(model, m.providers);
    if (mid.includes(":free") || p === "herd") {
      const r = await callOne(m, p, mid, body, signal);
      if (r.ok) {
        m.stickySet(session, p, mid);
        m.record(mid, p, 200, r.lat, 1, "free", session);
      }
      return r;
    }
  }
  const cands: Array<[string, string]> = [];
  for (const [name, prov] of Object.entries(m.providers)) {
    if (!m.keyOk(name) || !m.circuitOk(name)) continue;
    for (const mid of prov.models) {
      if (mid.includes(":free")) cands.push([name, mid]);
    }
  }
  if (m.keyOk("herd")) cands.push(["herd", "local-quality"]);
  if (cands.length === 0) {
    return { ok: false, status: 503, provider: "", model: "", lat: 0, err: "no_free_providers", winner: 0 };
  }
  return raceCandidates(m, body, session, cands, "free", signal);
}

/** Fan out to candidates with a 95s ceiling (mirrors the Go timeout). */
async function fanOut(
  m: Matrix,
  cands: Array<[string, string]>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RouteResult[]> {
  const max = m.getConfig().maxParallel;
  const limited = cands.slice(0, max);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 95_000);
  const combined = anySignal(signal, ctrl.signal);
  try {
    const settled = await Promise.allSettled(
      limited.map(([p, mid]) => callOne(m, p, mid, body, combined)),
    );
    return settled.map((s) =>
      s.status === "fulfilled"
        ? s.value
        : { ok: false, status: 500, provider: "", model: "", lat: 0, err: "race_aborted", winner: 0 },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function raceCandidates(
  m: Matrix,
  body: Record<string, unknown>,
  session: string,
  cands: Array<[string, string]>,
  strategy: string,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const results = await fanOut(m, cands, body, signal);
  let best: RouteResult | null = null;
  for (const r of results) {
    if (!r.ok) continue;
    if (r.data && r.data.length > 0) {
      const content = extractContent(r.data);
      if (content !== null && isAST(content)) {
        m.stickySet(session, r.provider, r.model);
        m.record(r.model, r.provider, 200, r.lat, 1, strategy, session);
        return r;
      }
    }
    if (!best) best = r;
  }
  if (best) {
    m.stickySet(session, best.provider, best.model);
    return best;
  }
  return { ok: false, status: 503, provider: "", model: "", lat: 0, err: `${strategy}_exhausted`, winner: 0 };
}

export const strategies: Record<string, StrategyFn> = {
  "hybrid": routeHybrid,
  "ast_race": routeAstRace,
  "sticky_affinity": routeSticky,
  "weighted_elo": routeWeighted,
  "circuit_chain": routeCircuitChain,
  "fifo_matrix": routeFifo,
  "free": routeFree,
};

function getModel(body: Record<string, unknown>): string {
  const v = body["model"];
  return typeof v === "string" ? v : "auto";
}

/** Extract choices[0].message.content from an OpenAI chat response. */
function extractContent(data: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const c = parsed.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

/** Retry-After header -> ms (re-exported shape for router use). */
function parseRetryAfterMs(val: string): number {
  if (!val) return 0;
  const t = val.trim();
  if (/^\d+$/.test(t)) {
    const s = parseInt(t, 10);
    return s > 0 ? s * 1000 : 0;
  }
  const d = Date.parse(t);
  if (!isNaN(d)) {
    const dur = d - Date.now();
    return dur > 0 ? dur : 0;
  }
  return 0;
}

/** X-RateLimit-Reset header -> ms until reset. */
function parseRateLimitResetMs(val: string): number {
  if (!val) return 0;
  const ts = parseInt(val.trim(), 10);
  if (isNaN(ts)) return 0;
  const ms = ts > 1e12 ? ts : ts * 1000;
  const dur = ms - Date.now();
  return dur > 0 ? dur : 0;
}
