/**
 * flock/ts/strategy/catalog — provider catalog helpers for the strategy tier.
 *
 * Adapted from estate-scripts-router's router_config.ts. The master provider
 * definitions live in the Roost package (../../roost/src); this module
 * projects them into routing-relevant ProviderViews and ports the pure
 * catalog functions the strategies need: key resolution, model-spec
 * normalization ("provider:model" / "provider/model" / bare / alias),
 * free-model eligibility, and local role models.
 *
 * Nothing here touches the network or the filesystem at import time
 * except loadLocalRoleModels(), which reads the (optional) runtime role
 * overlay — same contract as the original.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ProviderDef } from "../../roost/src/types.ts";
import type { ProviderView } from "./types.ts";

// ---------------------------------------------------------------------------
// Timing / strategy constants (env-overridable, same names as the router)
// ---------------------------------------------------------------------------
export const MAX_PARALLEL = 4;
export const FIFO_MAX = 64;
export const DEFAULT_STRATEGY = process.env.estate-scripts_STRATEGY || "hybrid";
export const UA = "Mozilla/5.0 (compatible; estate-scripts-Flock/3.1)";

/** Connect (headers) budget per attempt. */
export const CONNECT_MS = parseInt(process.env.estate-scripts_CONNECT_MS || "8000", 10);
/** Time-to-first-byte budget for streams. */
export const TTFT_MS = parseInt(process.env.estate-scripts_TTFT_MS || "45000", 10);
/** Total per-attempt cap (non-stream). */
export const ATTEMPT_MS = parseInt(process.env.estate-scripts_ATTEMPT_MS || "120000", 10);
/** Total per-attempt cap (stream). */
export const ATTEMPT_STREAM_MS = parseInt(
  process.env.estate-scripts_ATTEMPT_STREAM_MS || "300000",
  10,
);
/** Hedge delay: preferred lane gets this long before the field races. 0 = sequential. */
export const HEDGE_MS = parseInt(process.env.estate-scripts_HEDGE_MS || "1500", 10);

/** Code-shaped output detector (AST race preference). */
export const AST_RE =
  /(def |class |import |from |function |const |let |var |#include|package |fn |pub |struct |impl |async |await |\.ts|\.py|\.rs|\.js|AST|tree-sitter|syntax|```)/i;

export function isAst(text: string): boolean {
  return Boolean(
    text && (AST_RE.test(text.slice(0, 5000)) || text.includes("```")),
  );
}

// ---------------------------------------------------------------------------
// Local role models (herd)
// ---------------------------------------------------------------------------
export interface LocalRoles {
  fast: string;
  quality: string;
  longctx: string;
}

export function loadLocalRoleModels(): LocalRoles {
  const defaults: LocalRoles = {
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
// ProviderView construction from Roost defs
// ---------------------------------------------------------------------------
export function providerView(def: ProviderDef): ProviderView {
  return {
    name: def.name,
    baseUrl: def.baseUrl.replace(/\/$/, ""),
    keyEnv: def.keyEnv,
    ...(def.keyEnvAlt ? { keyEnvAlt: def.keyEnvAlt } : {}),
    ...(def.auth === "none" ? { noAuth: true } : {}),
    ...(def.extraHeaders ? { extraHeaders: def.extraHeaders } : {}),
  };
}

export function providerViews(defs: ProviderDef[]): ProviderView[] {
  return defs.filter((d) => d.enabled !== false).map(providerView);
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------
/** First non-empty key wins (pool alt first, like the router). */
export function resolveKeyEnv(view: ProviderView): string | undefined {
  if (view.keyEnvAlt) {
    const pool = (process.env[view.keyEnvAlt] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (pool.length > 0) return pool[0];
  }
  return process.env[view.keyEnv];
}

export function keyOkFor(view: ProviderView): boolean {
  if (view.noAuth) return true;
  return Boolean(resolveKeyEnv(view));
}

/** NVIDIA multi-key pool (all keys, for the token-bucket rotator). */
export function nvidiaKeys(): string[] {
  return (process.env.NVIDIA_API_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Model aliases (CODING) — local routing aliases overlaying Roost's map
// ---------------------------------------------------------------------------
export function buildCoding(
  roles: LocalRoles,
  pkgAliases: Record<string, [string, string]>,
): Record<string, [string, string] | null> {
  return {
    auto: null,
    fcm: null,
    // free: route through the `free` strategy (local + all :free cloud models)
    free: null,
    // Local-first ranked roles (herd exclusive matrix)
    fast: ["herd", roles.fast],
    "local-fast": ["herd", roles.fast],
    quality: ["herd", roles.quality],
    "local-quality": ["herd", roles.quality],
    longctx: ["herd", roles.longctx],
    "local-longctx": ["herd", roles.longctx],
    "local-auto": ["herd", roles.quality],
    ...pkgAliases,
  };
}

// ---------------------------------------------------------------------------
// Catalog query helpers (parameterized — callers supply the catalog)
// ---------------------------------------------------------------------------
export interface CatalogQuery {
  providerNames(): string[];
  servingModels(provider: string): string[];
  isQuarantined(provider: string, model: string): boolean;
  deadIds(): Set<string>;
  keyOk(provider: string): boolean;
}

export function firstModelFor(
  p: string,
  q: CatalogQuery,
  roles: LocalRoles = LOCAL_ROLES,
): string {
  if (p === "herd") return roles.quality;
  return q.servingModels(p)[0] || "";
}

export function isLocalSwapModelId(
  model: string,
  coding: Record<string, [string, string] | null>,
  roles: LocalRoles = LOCAL_ROLES,
): boolean {
  if (!model || model === "auto" || model === "fcm") return false;
  if (model in coding && coding[model]?.[0] === "herd") return true;
  if (model === roles.fast || model === roles.quality || model === roles.longctx) {
    return true;
  }
  // estate-scripts naming prefixes / known local ids
  return /^(beellama|mradermacher|jackrong|turboquant|ik_llama|ik_turboquant|holo|qwen\/|gemma-4|exaone)/i.test(
    model,
  );
}

export function isExplicit(
  model: string,
  coding: Record<string, [string, string] | null>,
  roles: LocalRoles = LOCAL_ROLES,
): boolean {
  return (
    (model in coding && coding[model] != null) ||
    isLocalSwapModelId(model, coding, roles)
  );
}

/** Best catalog model id on provider p matching a loose name `rest`. */
export function matchModelOnProvider(
  p: string,
  rest: string,
  q: CatalogQuery,
): string | null {
  const r = (rest || "").trim();
  if (!r) return null;
  const cat = q.servingModels(p);
  if (cat.includes(r)) return r;
  const stripTag = (m: string) => m.split(":")[0];
  const rBase = stripTag(r).split("/").pop()!.toLowerCase();
  for (const m of cat) {
    if (stripTag(m).split("/").pop()!.toLowerCase() === rBase) return m;
  }
  return null;
}

export interface NormalizedSpec {
  provider: string | null;
  model: string;
}

/**
 * normalizeModelSpec — the openfang `agent set` parsing shim.
 * Accepts every spec shape the (buggy) fork can produce and returns a
 * canonical { provider, model }:
 *   "nvidia:gpt-oss-20b"                  -> { provider: "nvidia", model: <best catalog match> }
 *   "openrouter/openai/gpt-oss-20b:free"  -> { provider: "openrouter", model: <same> }
 *   "fast" / "auto"                       -> { provider: null, model: <alias untouched> }
 * provider is null when the spec is provider-agnostic (alias or bare
 * model id); callers fall back to resolveModel()'s catalog search.
 */
export function normalizeModelSpec(
  spec: string,
  q: CatalogQuery,
  coding: Record<string, [string, string] | null>,
): NormalizedSpec {
  const s = (spec || "").trim();
  if (!s) return { provider: null, model: "auto" };
  // CODING aliases pass through untouched.
  if (s in coding) return { provider: null, model: s };
  const provNames = q.providerNames();
  const inCatalog = (p: string, m: string) => q.servingModels(p).includes(m);
  const anyCatalogHas = (m: string) => provNames.some((p) => inCatalog(p, m));
  // Bare model id already in some catalog: provider-agnostic.
  if (anyCatalogHas(s)) return { provider: null, model: s };
  // "provider:model" colon form (the exact shape the fork mangles).
  const ci = s.indexOf(":");
  if (ci > 0) {
    const pre = s.slice(0, ci).toLowerCase();
    if (provNames.includes(pre)) {
      const rest = s.slice(ci + 1);
      const mid = matchModelOnProvider(pre, rest, q);
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
      const mid = matchModelOnProvider(pre, rest, q);
      if (mid) return { provider: pre, model: mid };
    }
  }
  return { provider: null, model: s };
}

export function resolveModel(
  model: string,
  q: CatalogQuery,
  coding: Record<string, [string, string] | null>,
  roles: LocalRoles = LOCAL_ROLES,
): [string, string] {
  const norm = normalizeModelSpec(model, q, coding);
  if (norm.provider) return [norm.provider, norm.model];
  if (model in coding && coding[model] != null) {
    const [p, m] = coding[model]!;
    // A dead or quarantined alias target is not routable — fall through to
    // the healthy field instead of burning a 404 on a known-bad id.
    if (!q.deadIds().has(m) && !q.isQuarantined(p, m)) return [p, m];
  }
  // Prefer herd for any local GGUF id so hybrid never sends GPU models to Gemini
  if (isLocalSwapModelId(model, coding, roles)) return ["herd", model];
  if (model === "auto" || model === "fcm") {
    // local-first auto: quality role on swap
    return ["herd", roles.quality];
  }
  for (const p of q.providerNames()) {
    if (q.servingModels(p).includes(model)) return [p, model];
  }
  if (q.keyOk("openrouter")) return ["openrouter", model];
  if (q.keyOk("nvidia")) return ["nvidia", model];
  return ["herd", roles.quality];
}

// ---------------------------------------------------------------------------
// Live-metadata free eligibility (Chris 2026-09-17: routing must consume
// the live /models metadata, not a divergent static list).
//
// modelFree(p, mid, meta) is the single source of truth for "this model
// costs us nothing on this key":
//   1. Live metadata wins: OpenRouter-style /models carries pricing;
//      prompt + completion priced "0" means zero-cost on our key. A
//      provider-set boolean "free" flag is honored too.
//   2. Deterministic fallback: providers whose /models carry no pricing
//      metadata keep the ":free" suffix convention, so a failed discovery
//      refresh never empties the pool.
// ---------------------------------------------------------------------------
export function modelFree(
  mid: string,
  meta: Record<string, unknown> | undefined,
): boolean {
  const pricing = meta?.["pricing"] as Record<string, unknown> | undefined;
  if (pricing && typeof pricing === "object") {
    const zero = (v: unknown) => v === "0" || v === 0;
    return zero(pricing["prompt"]) && zero(pricing["completion"]);
  }
  if (typeof meta?.["free"] === "boolean") return meta["free"] as boolean;
  return mid.includes(":free");
}

export function log(...args: unknown[]) {
  console.error("[flock-strategy]", ...args);
}
