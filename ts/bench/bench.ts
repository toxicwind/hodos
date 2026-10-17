#!/usr/bin/env bun
/**
 * flock/ts/bench — reusable provider benchmark runner (Bun/TS).
 *
 * Ported from estate-scripts-router's provider-bench.ts. For each configured
 * model on a provider it measures:
 *   1. liveness: one real completion, semantic-failure aware
 *      (empty output, echo of the prompt, or refusal markers = unhealthy)
 *   2. quality: N deterministic instruction-following requests
 *      (exact sentinel match = 2, contains = 1, else 0) — same 0-2 scale
 *      as the GuideLLM ranking-eval, so priors stay comparable
 *   3. latency: per-request ms, p50 reported
 *
 * Provider definitions and model lists come from the Roost package
 * (../../roost/src) — the same catalog the strategy tier routes against —
 * instead of a divergent static list. `servingModels()` (live discovery ∪
 * seeds, minus quarantine/dead) is the bench population.
 *
 * Doctrine (borrowed from the estate's own scars):
 *   - fail-fast: per-request timeout, NO retries. A 429/401/timeout is
 *     DATA (recorded on the model), never a retry signal.
 *   - 429 stops the provider: rate-limit is a stop condition, not a
 *     backoff-and-hammer loop.
 *   - catalog before completion: /models is liveness of the catalog,
 *     not of completion. Every model gets a real completion probe.
 *   - keys never leave the box: reads KEY_ENV from the environment at
 *     runtime; run this ON yote where ~/.secrets is sourced.
 *
 * Usage:
 *   bench run --provider groq [--models a,b] [--reqs 3]
 *       [--concurrency 2] [--timeout-ms 45000] [--out-dir bench-runs]
 *   bench catalog --provider groq   # list live /models ids
 *   bench list                       # show past runs
 *   bench providers                  # show configured providers + models
 *
 * Output: bench-runs/<ts>-<provider>.json — full evidence per model:
 *   http status, latency_ms per request, quality scores, liveness verdict,
 *   and the raw sentinel prompt used. Merge into the policy tier's
 *   bench-priors.json with the strategy the policy README documents.
 */
import { DEAD_MODEL_IDS, ModelCatalog, MODEL_ALIASES, PROVIDER_DEFS } from "../../roost/src/index.ts";
import type { ProviderDef as RoostProviderDef } from "../../roost/src/types.ts";

const QUALITY_PROMPTS = [
  "Output exactly: ABSTRACT-7X3Q. No other text.",
  "Output exactly: KITE-99PL. No other text.",
  "Output exactly: VOLT-42ZM. No other text.",
  "Output exactly: FERN-18QK. No other text.",
  "Output exactly: DRIFT-77WX. No other text.",
];
const SENTINELS = ["ABSTRACT-7X3Q", "KITE-99PL", "VOLT-42ZM", "FERN-18QK", "DRIFT-77WX"];

const REFUSAL_MARKERS = [
  "i'm sorry", "i am sorry", "i can't", "i cannot", "as an ai",
  "unable to comply", "not able to",
];

/**
 * Deliberately NOT benched: herd (local compute not for tasks),
 * kimi-auto (Moonshot 429 — no top-up, Chris's call), openrouter
 * (already has GuideLLM priors from benchlink).
 */
export const BENCH_EXCLUDE = new Set(["herd", "kimi-auto", "openrouter"]);

export interface BenchProviderDef {
  name: string;
  base: string;
  keyEnv: string;
  /** alt pool (e.g. NVIDIA_API_KEYS): first non-empty key wins, like the router */
  keyEnvAlt?: string;
  /** chat-completion-capable model ids, from live discovery / seeds */
  models?: string[];
  /** models endpoint path (default /models) */
  modelsPath?: string;
}

/** Build bench defs from the Roost master catalog (excludes the NOT-benched set). */
export function benchDefs(catalog?: ModelCatalog): Record<string, BenchProviderDef> {
  const cat = catalog ?? new ModelCatalog(PROVIDER_DEFS, {
    aliases: MODEL_ALIASES,
    deadIds: DEAD_MODEL_IDS,
  });
  const out: Record<string, BenchProviderDef> = {};
  for (const def of PROVIDER_DEFS) {
    if (BENCH_EXCLUDE.has(def.name)) continue;
    if (def.enabled === false) continue;
    out[def.name] = {
      name: def.name,
      base: def.baseUrl,
      keyEnv: def.keyEnv,
      ...(def.keyEnvAlt ? { keyEnvAlt: def.keyEnvAlt } : {}),
      models: cat.servingModels(def.name),
      ...(def.modelsPath ? { modelsPath: def.modelsPath } : {}),
    };
  }
  return out;
}

/** Raw Roost def for a benchable provider (undefined when excluded/unknown). */
export function roostDef(name: string): RoostProviderDef | undefined {
  return PROVIDER_DEFS.find((d) => d.name === name && !BENCH_EXCLUDE.has(name));
}

export interface RequestResult {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  text: string | null;
  error: string | null;
}

export interface ModelResult {
  model: string;
  liveness: { healthy: boolean; reason: string; latencyMs: number | null };
  quality: { scores: number[]; mean: number; n: number };
  latencyP50Ms: number | null;
  rateLimited: boolean;
  keyDead: boolean;
}

export interface RunResult {
  tool: "flock-bench";
  version: 1;
  startedAt: string;
  provider: string;
  base: string;
  config: { reqs: number; concurrency: number; timeoutMs: number };
  models: ModelResult[];
  providerRateLimited: boolean;
  providerKeyDead: boolean;
}

export function scoreQuality(text: string, sentinel: string): number {
  const t = text.trim();
  if (t === sentinel) return 2;
  if (t.includes(sentinel)) return 1;
  return 0;
}

export function livenessVerdict(text: string | null): { healthy: boolean; reason: string } {
  if (!text || text.trim().length === 0)
    return { healthy: false, reason: "empty completion" };
  const low = text.toLowerCase();
  for (const m of REFUSAL_MARKERS)
    if (low.includes(m)) return { healthy: false, reason: "refusal marker" };
  return { healthy: true, reason: "ok" };
}

export function p50(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function resolveKey(def: BenchProviderDef): string | undefined {
  if (def.keyEnvAlt) {
    const pool = (process.env[def.keyEnvAlt] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (pool.length > 0) return pool[0];
  }
  return process.env[def.keyEnv];
}

async function chatCompletion(
  base: string,
  key: string,
  model: string,
  prompt: string,
  timeoutMs: number
): Promise<RequestResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        // 300 matches the e2e-probe instrument: headroom for reasoning
        // models (gemini-3.8-flash burned 64 tokens thinking and output
        // nothing), scoring is on the text, not the length
        max_tokens: 300,
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        httpStatus: res.status,
        latencyMs,
        text: null,
        error: `http ${res.status}: ${body.slice(0, 160)}`,
      };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? null;
    return { ok: true, httpStatus: 200, latencyMs, text, error: null };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      httpStatus: null,
      latencyMs,
      text: null,
      error: msg.includes("abort") ? "timeout" : msg.slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function benchModel(
  def: BenchProviderDef,
  key: string,
  model: string,
  reqs: number,
  timeoutMs: number,
  stop: { rateLimited: boolean; keyDead: boolean }
): Promise<ModelResult> {
  const latencies: number[] = [];
  let rateLimited = false;
  let keyDead = false;

  // 1. liveness: one real completion
  const live = await chatCompletion(def.base, key, model, "Reply with exactly: PING-OK", timeoutMs);
  if (live.httpStatus === 429) {
    stop.rateLimited = true;
    rateLimited = true;
  }
  if (live.httpStatus === 401 || live.httpStatus === 403) {
    stop.keyDead = true;
    keyDead = true;
  }
  const verdict = live.ok ? livenessVerdict(live.text) : { healthy: false, reason: live.error ?? "request failed" };
  if (live.latencyMs !== null) latencies.push(live.latencyMs);

  // 2. quality: N deterministic instruction-following requests
  const scores: number[] = [];
  const n = Math.min(reqs, QUALITY_PROMPTS.length);
  for (let i = 0; i < n; i++) {
    if (stop.rateLimited || stop.keyDead) break;
    const r = await chatCompletion(def.base, key, model, QUALITY_PROMPTS[i]!, timeoutMs);
    if (r.httpStatus === 429) {
      stop.rateLimited = true;
      rateLimited = true;
      break;
    }
    if (r.httpStatus === 401 || r.httpStatus === 403) {
      stop.keyDead = true;
      keyDead = true;
      break;
    }
    if (r.latencyMs !== null) latencies.push(r.latencyMs);
    scores.push(r.ok && r.text !== null ? scoreQuality(r.text, SENTINELS[i]!) : 0);
  }

  const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return {
    model,
    liveness: {
      healthy: verdict.healthy,
      reason: verdict.reason,
      latencyMs: live.latencyMs,
    },
    quality: { scores, mean: Math.round(mean * 1000) / 1000, n: scores.length },
    latencyP50Ms: p50(latencies),
    rateLimited,
    keyDead,
  };
}

async function runPool<T>(items: T[], concurrency: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runProvider(
  provider: string,
  opts: { models?: string[]; reqs: number; concurrency: number; timeoutMs: number },
  defs: Record<string, BenchProviderDef> = benchDefs(),
): Promise<RunResult> {
  const def = defs[provider];
  if (!def) throw new Error(`unknown provider: ${provider}`);
  const key = resolveKey(def);
  if (!key) throw new Error(`key env ${def.keyEnv} not set — source ~/.secrets on yote`);
  const models = opts.models ?? def.models ?? [];
  const stop = { rateLimited: false, keyDead: false };
  const results: ModelResult[] = [];
  await runPool(models, opts.concurrency, async (model) => {
    if (stop.rateLimited || stop.keyDead) {
      results.push({
        model,
        liveness: { healthy: false, reason: "skipped: provider stopped", latencyMs: null },
        quality: { scores: [], mean: 0, n: 0 },
        latencyP50Ms: null,
        rateLimited: stop.rateLimited,
        keyDead: stop.keyDead,
      });
      return;
    }
    const r = await benchModel(def, key, model, opts.reqs, opts.timeoutMs, stop);
    results.push(r);
    const q = r.quality.mean.toFixed(2);
    console.log(
      `  ${model}: live=${r.liveness.healthy ? "OK" : "FAIL(" + r.liveness.reason + ")"} ` +
        `quality=${q} p50=${r.latencyP50Ms ?? "-"}ms` +
        (r.rateLimited ? " RATELIMITED" : "") +
        (r.keyDead ? " KEYDEAD" : "")
    );
  });
  results.sort((a, b) => models.indexOf(a.model) - models.indexOf(b.model));
  return {
    tool: "flock-bench",
    version: 1,
    startedAt: new Date().toISOString(),
    provider,
    base: def.base,
    config: { reqs: opts.reqs, concurrency: opts.concurrency, timeoutMs: opts.timeoutMs },
    models: results,
    providerRateLimited: stop.rateLimited,
    providerKeyDead: stop.keyDead,
  };
}

export async function catalogModels(
  provider: string,
  defs: Record<string, BenchProviderDef> = benchDefs(),
): Promise<string[]> {
  const def = defs[provider];
  if (!def) throw new Error(`unknown provider: ${provider}`);
  const key = resolveKey(def);
  if (!key) throw new Error(`key env ${def.keyEnv} not set`);
  const res = await fetch(`${def.base}${def.modelsPath ?? "/models"}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`catalog http ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}

function usage(exitCode = 2): never {
  process.stderr.write(
    `flock bench — reusable provider benchmark runner.

  run --provider NAME [--models a,b] [--reqs 3] [--concurrency 2]
      [--timeout-ms 45000] [--out-dir bench-runs]
      Benchmark a provider: liveness + quality + latency. Writes
      bench-runs/<ts>-<provider>.json. No retries; 429 stops the provider.
  catalog --provider NAME
      List live /models ids for a provider.
  list [--out-dir bench-runs]
      Show past runs.
  providers
      List configured providers and their models (from the Roost catalog).
`
  );
  process.exit(exitCode);
}

function parseArgs(raw: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  let i = 0;
  while (i < raw.length) {
    const a = raw[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const nx = raw[i + 1];
      if (nx === undefined || nx.startsWith("--")) {
        out[k] = true;
        i++;
      } else {
        out[k] = nx;
        i += 2;
      }
    } else {
      const pos = out["__pos"];
      out["__pos"] = (typeof pos === "string" ? pos + " " : "") + a;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const defs = benchDefs();

  if (cmd === "providers") {
    for (const [name, def] of Object.entries(defs)) {
      console.log(`${name} (${def.base}, key: ${def.keyEnv}):`);
      for (const m of def.models ?? []) console.log(`  - ${m}`);
    }
    return;
  }
  if (cmd === "catalog") {
    const p = str("provider");
    if (!p) usage();
    const ids = await catalogModels(p, defs);
    console.log(ids.join("\n"));
    return;
  }
  if (cmd === "list") {
    const dir = str("out-dir") || "bench-runs";
    const glob = new Bun.Glob("*.json");
    const files: string[] = [];
    for await (const f of glob.scan({ cwd: dir, absolute: true })) files.push(f);
    files.sort().reverse();
    if (files.length === 0) {
      console.log("(no runs)");
      return;
    }
    for (const f of files) {
      try {
        const r = (await Bun.file(f).json()) as RunResult;
        const ok = r.models.filter((m) => m.liveness.healthy).length;
        console.log(
          `${f.split("/").pop()}  ${r.provider}  ${ok}/${r.models.length} healthy  ${r.startedAt}`
        );
      } catch {
        console.log(`${f.split("/").pop()}  (unreadable)`);
      }
    }
    return;
  }
  if (cmd === "run") {
    const provider = str("provider");
    if (!provider) usage();
    const reqs = parseInt(str("reqs") || "3", 10);
    const concurrency = parseInt(str("concurrency") || "2", 10);
    const timeoutMs = parseInt(str("timeout-ms") || "45000", 10);
    const outDir = str("out-dir") || "bench-runs";
    const models = str("models") ? str("models").split(",").map((s) => s.trim()) : undefined;
    console.log(`benchmarking ${provider} (${models?.length ?? defs[provider]!.models?.length ?? 0} models, ${reqs} reqs/model)...`);
    const result = await runProvider(provider, { models, reqs, concurrency, timeoutMs }, defs);
    await Bun.$`mkdir -p ${outDir}`.quiet();
    const stamp = result.startedAt.replace(/[:.]/g, "-");
    const path = `${outDir}/${stamp}-${provider}.json`;
    await Bun.write(path, JSON.stringify(result, null, 2) + "\n");
    const healthy = result.models.filter((m) => m.liveness.healthy).length;
    console.log(`wrote ${path}: ${healthy}/${result.models.length} healthy` +
      (result.providerRateLimited ? " (provider rate-limited)" : "") +
      (result.providerKeyDead ? " (provider key dead)" : ""));
    return;
  }
  usage();
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`flock bench: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
