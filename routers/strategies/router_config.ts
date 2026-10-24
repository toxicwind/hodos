import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Secrets + local stack env (mise loads these; standalone bun needs them too)
// ---------------------------------------------------------------------------
export function loadEnvFile(path: string, overwrite = false): void {
  if (!existsSync(path)) return;
  try {
    for (let line of readFileSync(path, "utf8").split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice(7);
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      let v = line
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (k && v && (overwrite || !process.env[k])) process.env[k] = v;
    }
  } catch (e) {
    console.error(`[matrix] loadEnvFile ${path}:`, e);
  }
}

loadEnvFile(`${homedir()}/.secrets`);

loadEnvFile("/home/toxic/.secrets");

loadEnvFile("/home/toxic/estate/config/ports.env");

loadEnvFile("/home/toxic/estate/.env.local");

// Port SSOT: process-compose injects ESTATE_PORT=${ESTATE_ROUTER_PORT}
export const _portRaw =
  process.env.ESTATE_PORT || process.env.ESTATE_ROUTER_PORT || "";

if (!_portRaw) {
  throw new Error(
    "ESTATE_ROUTER_PORT or ESTATE_PORT required (config/ports.env)",
  );
}

export const PORT = parseInt(_portRaw, 10);

export const DB_PATH =
  process.env.ESTATE_DB || "/home/toxic/estate/data/estate_router.db";

export const MAX_PARALLEL = 4;

// --- Resilience tunables (v3.2; all env-overridable, failfast-first) ---
// CONNECT_MS: headers must arrive (dead backend detected fast).
// TTFT_MS: first body byte must arrive for streaming (time-to-first-token).
// ATTEMPT_MS / ATTEMPT_STREAM_MS: total per-attempt caps.
export const CONNECT_MS = parseInt(process.env.ESTATE_CONNECT_MS || "8000", 10);
export const TTFT_MS = parseInt(process.env.ESTATE_TTFT_MS || "45000", 10);
export const ATTEMPT_MS = parseInt(process.env.ESTATE_ATTEMPT_MS || "120000", 10);
export const ATTEMPT_STREAM_MS = parseInt(
  process.env.ESTATE_ATTEMPT_STREAM_MS || "180000",
  10,
);
// QUARANTINE: dead providers are quarantined with exponential backoff
// re-probing: BASE * 2^(level-1) capped at MAX.
export const QUARANTINE_BASE_S = parseInt(
  process.env.ESTATE_QUARANTINE_BASE_S || "60",
  10,
);
export const QUARANTINE_MAX_S = parseInt(
  process.env.ESTATE_QUARANTINE_MAX_S || "1800",
  10,
);
// HEDGE_MS: speculative hedging (HFT redundant-feeds pattern). When a chain
// lane hasn't produced a winner within HEDGE_MS, the next lane fires in
// parallel; first substantive wins, losers are aborted. 0 disables.
export const HEDGE_MS = parseInt(process.env.ESTATE_HEDGE_MS || "1500", 10);

// Active quarantine re-probe cadence.
export const QUARANTINE_PROBE_MS = parseInt(
  process.env.ESTATE_QUARANTINE_PROBE_MS || "15000",
  10,
);

export const STICKY_TTL = 1800;

export const FIFO_MAX = 64;

export const STRATEGY = process.env.ESTATE_STRATEGY || "hybrid";

export const UA = "Mozilla/5.0 (compatible; Estate-Hodos/3.1)";

// ---------------------------------------------------------------------------
// HERD_V1 (must come before PROVIDERS that uses it)
// ---------------------------------------------------------------------------
export const HERD_V1 =
  process.env.LLM_BASE_URL ||
  process.env.HERD_V1 ||
  "http://127.0.0.1:25100/v1";

export function loadLocalRoleModels(): {
  fast: string;
  quality: string;
  longctx: string;
} {
  const defaults = {
    fast: "beellama/exaone-4-0-1-2b-iq4xs",
    quality: "beellama/qwen-flash-64k",
    longctx: "beellama/qwen-flash-256k",
  };
  try {
    const p = "/home/toxic/estate/.state/best-models.json";
    if (!existsSync(p)) return defaults;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return {
      fast: j?.roles?.fast?.id || j?.recommended?.preload || defaults.fast,
      quality:
        j?.roles?.quality?.id ||
        j?.recommended?.default_chat ||
        defaults.quality,
      longctx:
        j?.roles?.longctx?.id ||
        j?.recommended?.long_context ||
        defaults.longctx,
    };
  } catch {
    return defaults;
  }
}

export const LOCAL_ROLES = loadLocalRoleModels();

// ---------------------------------------------------------------------------
// Providers (must come before Catalog that depends on LOCAL_ROLES)
// ---------------------------------------------------------------------------
export const PROVIDERS: Record<
  string,
  { base: string; key_env: string; key_env_alt?: string; no_auth?: boolean }
> = {
  // Local SSOT — always first-class for estate GPU path
  "herd": {
    base: HERD_V1,
    key_env: "HERD_API_KEY",
    no_auth: true,
  },
  // Local NIM proxy (:8000, nim-consolidation track). Key via
  // NIM_PROXY_API_KEY; shows dead in /status until the proxy key lands --
  // the router then picks it up via hot reload (/admin/reload, SIGHUP).
  "nim-local": {
    base: process.env.NIM_PROXY_BASE || "http://127.0.0.1:8000/v1",
    key_env: "NIM_PROXY_API_KEY",
  },
  // kimi-auto sidecar shim (pitchfork daemon kimi-auto-shim): rewrites
  // model "kimi-auto" -> resolver's current best Kimi, forwards to herd.
  // Kimi-only by design (shim 503s when no Kimi candidate is healthy).
  "kimi-auto": {
    base:
      process.env.KIMI_AUTO_SHIM_BASE ||
      "http://127.0.0.1:" + (process.env.KIMI_AUTO_SHIM_PORT || "25105") + "/v1",
    key_env: "KIMI_AUTO_SHIM_KEY",
    no_auth: true,
  },
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    key_env: "OPENROUTER_API_KEY",
  },
  // NVIDIA direct (the :8000 key-proxy is retired — multi-key rotation and
  // per-key rate limiting now live in the router itself, see router_matrix).
  nvidia: {
    base: "https://integrate.api.nvidia.com/v1",
    key_env: "NVIDIA_API_KEY",
    key_env_alt: "NVIDIA_API_KEYS",
  },
  groq: { base: "https://api.groq.com/openai/v1", key_env: "GROQ_API_KEY" },
  cerebras: {
    base: "https://api.cerebras.ai/v1",
    key_env: "CEREBRAS_API_KEY",
  },
  google: {
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    key_env: "GOOGLE_API_KEY",
  },
  mistral: { base: "https://api.mistral.ai/v1", key_env: "MISTRAL_API_KEY" },
};

// ---------------------------------------------------------------------------
// Catalog (depends on LOCAL_ROLES, must come after loadLocalRoleModels)
// ---------------------------------------------------------------------------
export const PROVIDER_MODELS: Record<string, string[]> = {
  "herd": [LOCAL_ROLES.fast, LOCAL_ROLES.quality, LOCAL_ROLES.longctx],
  "nim-local": [],
  "kimi-auto": ["kimi-auto"],
  openrouter: [
    // 2026-09-21 sweep: delisted IDs removed (verified against the public
    // /models list + live 404 probes): tencent/hy3:free, poolside/laguna-
    // m.1:free, nvidia/nemotron-3-nano-30b-a3b:free, qwen/qwen3-coder:free,
    // meta-llama/llama-3.3-70b-instruct:free,
    // nousresearch/hermes-3-llama-3.1-405b:free, openai/gpt-oss-20b:free.
    // Belt-and-braces: DEAD_MODEL_IDS also filters them if live discovery
    // re-lists them.
    "poolside/laguna-xs-2.1:free",
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "inclusionai/ling-3.0-flash-fin:free",
  ],
  nvidia: [
    "nvidia/nemotron-3-super-120b-a12b",
    // 2026-09-21: second entitled NVIDIA lane — serving 200s (0.8-10s),
    // genuine reasoning trace. Backup when super flaps; Elo sorts it live.
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "nvidia/nemotron-3-nano-30b-a3b",
    "meta/llama-3.1-70b-instruct",
    "qwen/qwen3.5-397b-a17b",
    "qwen/qwen3.5-122b-a10b",
    "deepseek-ai/deepseek-v4-flash",
    "deepseek-ai/deepseek-v4-pro",
    "mistralai/mistral-large-3-675b-instruct-2512",
    "google/gemma-4-31b-it",
    "z-ai/glm-5.2",
    "thinkingmachines/inkling",
  ],
  groq: [
    "llama-3.3-70b-versatile",
    "qwen/qwen3-32b",
    "qwen/qwen3.6-27b",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
  ],
  cerebras: [],
  google: [
    "models/gemini-2.5-flash",
    "models/gemini-2.5-flash-lite",
    "models/gemini-2.0-flash",
    "models/gemma-4-31b-it",
  ],
  mistral: [
    "mistral-small-latest",
    "codestral-latest",
    "mistral-large-latest",
    "mistral-medium-latest",
  ],
};

// ---------------------------------------------------------------------------
// Live per-model metadata (populated at runtime by router_live_models.ts):
// provider -> model id -> raw provider /models object (pricing, context
// length, architecture...). IDs stay in LIVE_MODELS for routing; metadata
// enriches /v1/models so clients see live data, not just id strings.
export const LIVE_MODEL_META: Record<string, Record<string, unknown>> = {};

// NVIDIA multi-key pool (absorbed from the retired :8000 key-proxy):
// comma-separated nvapi-* keys, each with its own 40rpm token bucket
// (see Matrix.nextNvidiaKey in router_matrix.ts).
export function nvidiaKeys(): string[] {
  const pool = (process.env.NVIDIA_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pool.length) return pool;
  const single = process.env.NVIDIA_API_KEY || "";
  return single ? [single] : [];
}

// ---------------------------------------------------------------------------
// Live model catalog (populated at runtime by router_live_models.ts)
// ---------------------------------------------------------------------------
// Curated PROVIDER_MODELS above is the stable base (aliases, :free suffix
// conventions). LIVE_MODELS is filled from each provider's GET /models
// endpoint using that provider's own API key, so the router serves every
// model each key is entitled to - not just the hardcoded subset.
// catalogModelsFor() = curated union live, curated first.
export const LIVE_MODELS: Record<string, string[]> = {};

export function catalogModelsFor(p: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...(PROVIDER_MODELS[p] || []), ...(LIVE_MODELS[p] || [])]) {
    if (typeof m === "string" && m && !seen.has(m) && !DEAD_MODEL_IDS.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/**
 * DEAD_MODEL_IDS — permanently retired model IDs (503-forensics 2026-09-21).
 *
 * NVIDIA 410-retired / OpenRouter-delisted IDs. They 404 (or 410) on every
 * attempt and never self-heal — only an NVIDIA-side relist would revive
 * them, at which point this list gets edited. Filtered in
 * catalogModelsFor, the single choke point for provider model lists, so
 * dead IDs can enter neither the race sets nor explicit routing (an
 * explicit request for one falls through to the healthy hybrid field
 * instead of burning a 404).
 *
 * The runtime entitlement-404 bench (Matrix.noteEntitlement404) is the
 * dynamic layer for IDs that die mid-process; this list is the static
 * layer for IDs already known dead.
 */
export const DEAD_MODEL_IDS: Set<string> = new Set([
  // NVIDIA-retired (410), EOL dates from the retirement notices.
  "moonshotai/kimi-k2-instruct", // EOL 2026-05-12
  "meta/llama-3.1-8b-instruct", // EOL 2026-08-26
  "meta-llama/llama-3.1-8b-instruct", // EOL 2026-08-26 (openrouter form)
  "meta/llama-3.3-70b-instruct", // EOL 2026-08-26
  "meta-llama/llama-3.3-70b-instruct", // EOL 2026-08-26 (openrouter form)
  "meta-llama/llama-3.3-70b-instruct:free", // EOL 2026-08-26 (:free form)
  // OpenRouter-delisted (verified against the public /models list 2026-09-21).
  "tencent/hy3:free",
  "poolside/laguna-m.1:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "qwen/qwen3-coder:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "openai/gpt-oss-20b:free",
]);

// ---------------------------------------------------------------------------
// Live-metadata free eligibility (User 2026-09-17: routing must consume the
// live /models metadata, not a divergent static list).
//
// modelFree(p, mid) is the single source of truth for "this model costs us
// nothing on this key":
//   1. Live metadata wins: OpenRouter-style /models carries pricing; prompt +
//      completion priced "0" means zero-cost on our key. A provider-set
//      boolean "free" flag in the live object is honored too.
//   2. Deterministic fallback: providers whose /models carry no pricing
//      metadata (nvidia/groq/google/mistral) keep the ":free" suffix
//      convention, exactly as before. Curated ":free" ids with no live
//      metadata entry at all (delisted, fetch failure) also keep the suffix
//      rule, so the pool never silently empties on a bad refresh.
export function modelFree(p: string, mid: string): boolean {
  const meta = (LIVE_MODEL_META[p] || {})[mid] as
    | Record<string, unknown>
    | undefined;
  const pricing = meta?.["pricing"] as Record<string, unknown> | undefined;
  if (pricing && typeof pricing === "object") {
    const zero = (v: unknown) => v === "0" || v === 0;
    return zero(pricing["prompt"]) && zero(pricing["completion"]);
  }
  if (typeof meta?.["free"] === "boolean") return meta["free"] as boolean;
  return mid.includes(":free");
}

export const CODING: Record<string, [string, string] | null> = {
  auto: null,
  fcm: null,
  // free: route through the `free` strategy (local + all :free cloud models)
  free: null,
  // Local-first ranked roles (herd exclusive matrix)
  fast: ["herd", LOCAL_ROLES.fast],
  "local-fast": ["herd", LOCAL_ROLES.fast],
  quality: ["herd", LOCAL_ROLES.quality],
  "local-quality": ["herd", LOCAL_ROLES.quality],
  longctx: ["herd", LOCAL_ROLES.longctx],
  "local-longctx": ["herd", LOCAL_ROLES.longctx],
  "local-auto": ["herd", LOCAL_ROLES.quality],
  // 2026-09-21 sweep: aliases pointing at delisted/410 IDs removed —
  // hy3 (tencent/hy3:free), laguna-m1 (poolside/laguna-m.1:free),
  // qwen3-coder, llama-3.3-70b-free, hermes-3-405b, gpt-oss-20b,
  // nim-llama-3.3-70b. Requesting one now falls through to the healthy
  // hybrid field instead of burning a 404.
  ling: ["openrouter", "inclusionai/ling-3.0-flash-fin:free"],
  "laguna-xs": ["openrouter", "poolside/laguna-xs-2.1:free"],
  "gemma4-31b": ["openrouter", "google/gemma-4-31b-it:free"],
  "nemotron-super": ["openrouter", "nvidia/nemotron-3-super-120b-a12b:free"],
  "nemotron-nano": ["nvidia", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],
  "nim-nemotron-super": ["nvidia", "nvidia/nemotron-3-super-120b-a12b"],
  "nim-nemotron-omni": ["nvidia", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],
  "nim-nemotron-nano": ["nvidia", "nvidia/nemotron-3-nano-30b-a3b"],
  "nim-llama-3.1-70b": ["nvidia", "meta/llama-3.1-70b-instruct"],
  "nim-qwen3.5-397b": ["nvidia", "qwen/qwen3.5-397b-a17b"],
  "nim-qwen3.5-122b": ["nvidia", "qwen/qwen3.5-122b-a10b"],
  "nim-deepseek-v4-flash": ["nvidia", "deepseek-ai/deepseek-v4-flash"],
  "nim-deepseek-v4-pro": ["nvidia", "deepseek-ai/deepseek-v4-pro"],
  "nim-mistral-large-3": [
    "nvidia",
    "mistralai/mistral-large-3-675b-instruct-2512",
  ],
  "nim-gemma4-31b": ["nvidia", "google/gemma-4-31b-it"],
  "nim-glm5.2": ["nvidia", "z-ai/glm-5.2"],
  "nim-inkling": ["nvidia", "thinkingmachines/inkling"],
  "gemini-2.5-flash": ["google", "models/gemini-2.5-flash"],
  "gemini-2.5-flash-lite": ["google", "models/gemini-2.5-flash-lite"],
  "gemini-2.0-flash": ["google", "models/gemini-2.0-flash"],
  "gemma4-31b-google": ["google", "models/gemma-4-31b-it"],
  "mistral-small": ["mistral", "mistral-small-latest"],
  codestral: ["mistral", "codestral-latest"],
  "mistral-large": ["mistral", "mistral-large-latest"],
  "mistral-medium": ["mistral", "mistral-medium-latest"],
  "groq-llama-3.3-70b": ["groq", "llama-3.3-70b-versatile"],
  "groq-qwen3-32b": ["groq", "qwen/qwen3-32b"],
  "groq-qwen3.6-27b": ["groq", "qwen/qwen3.6-27b"],
  "groq-gpt-oss-120b": ["groq", "openai/gpt-oss-120b"],
  "groq-gpt-oss-20b": ["groq", "openai/gpt-oss-20b"],
  "groq-llama-4-scout": ["groq", "meta-llama/llama-4-scout-17b-16e-instruct"],
};

export const AST_RE =
  /(def |class |import |from |function |const |let |var |#include|package |fn |pub |struct |impl |async |await |\.ts|\.py|\.rs|\.js|AST|tree-sitter|syntax|```)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function getKey(p: string): string {
  // NVIDIA serves from the multi-key pool; first key is the default.
  if (p === "nvidia") return nvidiaKeys()[0] || "";
  const conf = PROVIDERS[p];
  if (!conf) return "";
  if (conf.no_auth) return "not-required-for-local";
  return (
    process.env[conf.key_env] ||
    (conf.key_env_alt ? process.env[conf.key_env_alt] : "") ||
    ""
  );
}

export function keyOk(p: string): boolean {
  if (p === "herd" || PROVIDERS[p]?.no_auth) return true;
  if (p === "nvidia") return nvidiaKeys().length > 0;
  const conf = PROVIDERS[p];
  if (!conf) return false;
  return Boolean(
    process.env[conf.key_env] ||
    (conf.key_env_alt ? process.env[conf.key_env_alt] : ""),
  );
}

export function firstModelFor(p: string): string {
  if (p === "herd") return LOCAL_ROLES.quality;
  return PROVIDER_MODELS[p]?.[0] || LIVE_MODELS[p]?.[0] || "";
}

export function isLocalSwapModelId(model: string): boolean {
  if (!model || model === "auto" || model === "fcm") return false;
  if (model in CODING && CODING[model]?.[0] === "herd") return true;
  if (
    model === LOCAL_ROLES.fast ||
    model === LOCAL_ROLES.quality ||
    model === LOCAL_ROLES.longctx
  ) {
    return true;
  }
  // estate naming prefixes / known local ids
  return /^(beellama|mradermacher|jackrong|turboquant|ik_llama|ik_turboquant|holo|qwen\/|gemma-4|exaone)/i.test(
    model,
  );
}

/**
 * normalizeModelSpec — the openfang `agent set` parsing shim (router-side).
 *
 * Accepts every spec shape the (buggy) fork can produce and returns a
 * canonical { provider, model }:
 *   "nvidia:gpt-oss-20b"      -> { provider: "nvidia", model: <best catalog match> }
 *   "openrouter/openai/gpt-oss-20b:free" -> { provider: "openrouter", model: <same> }
 *   "fast" / "auto"           -> { provider: null, model: <alias untouched> }
 *   "openrouter/inclusionai/ling-3.0-flash-fin:free" -> { provider: "openrouter", model: <same> }
 * provider is null when the spec is provider-agnostic (alias or bare model
 * id); callers then fall back to resolveModel()'s normal catalog search.
 */
export function normalizeModelSpec(spec: string): {
  provider: string | null;
  model: string;
} {
  const s = (spec || "").trim();
  if (!s) return { provider: null, model: "auto" };
  // CODING aliases pass through untouched.
  if (s in CODING) return { provider: null, model: s };
  const provNames = Object.keys(PROVIDERS);
  const inCatalog = (p: string, m: string) => catalogModelsFor(p).includes(m);
  const anyCatalogHas = (m: string) => provNames.some((p) => inCatalog(p, m));
  // Bare model id already in some catalog: provider-agnostic.
  if (anyCatalogHas(s)) return { provider: null, model: s };
  // "provider:model" colon form (the exact shape the fork mangles).
  const ci = s.indexOf(":");
  if (ci > 0) {
    const pre = s.slice(0, ci).toLowerCase();
    if (provNames.includes(pre)) {
      const rest = s.slice(ci + 1);
      const mid = matchModelOnProvider(pre, rest);
      if (mid) return { provider: pre, model: mid };
    }
  }
  // "provider/rest/of/id" slash form, e.g. "openrouter/openai/gpt-oss-20b:free".
  const si = s.indexOf("/");
  if (si > 0) {
    const pre = s.slice(0, si).toLowerCase();
    if (provNames.includes(pre)) {
      const rest = s.slice(si + 1);
      if (inCatalog(pre, rest)) return { provider: pre, model: rest };
      const mid = matchModelOnProvider(pre, rest);
      if (mid) return { provider: pre, model: mid };
    }
  }
  return { provider: null, model: s };
}

/** Best catalog model id on provider p matching a loose name `rest`. */
export function matchModelOnProvider(p: string, rest: string): string | null {
  const r = (rest || "").trim();
  if (!r) return null;
  const cat = catalogModelsFor(p);
  if (cat.includes(r)) return r;
  const stripTag = (m: string) => m.split(":")[0];
  const rBase = stripTag(r).split("/").pop()!.toLowerCase();
  for (const m of cat) {
    if (stripTag(m).split("/").pop()!.toLowerCase() === rBase) return m;
  }
  return null;
}

export function resolveModel(model: string): [string, string] {
  const norm = normalizeModelSpec(model);
  if (norm.provider) return [norm.provider, norm.model];
  if (model in CODING && CODING[model] != null) return CODING[model]!;
  // Prefer herd for any local GGUF id so hybrid never sends GPU models to Gemini
  if (isLocalSwapModelId(model)) return ["herd", model];
  if (model === "auto" || model === "fcm") {
    // local-first auto: quality role on swap
    return ["herd", LOCAL_ROLES.quality];
  }
  for (const p of Object.keys(PROVIDERS)) {
    if (catalogModelsFor(p).includes(model)) return [p, model];
  }
  if (keyOk("openrouter")) return ["openrouter", model];
  if (keyOk("nvidia")) return ["nvidia", model];
  return ["herd", LOCAL_ROLES.quality];
}

export function isAst(text: string): boolean {
  return Boolean(
    text && (AST_RE.test(text.slice(0, 5000)) || text.includes("```")),
  );
}

export function isExplicit(model: string): boolean {
  return (
    (model in CODING && CODING[model] != null) || isLocalSwapModelId(model)
  );
}

export function log(...args: unknown[]) {
  console.error("[router]", ...args);
}

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
