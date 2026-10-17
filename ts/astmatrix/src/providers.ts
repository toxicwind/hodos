/**
 * astmatrix-ts — provider catalog wiring.
 * Port of herd/internal/astmatrix/providers.go (Go) to Bun/TypeScript.
 *
 * The Go package sources its catalog from the generated Go artifacts
 * (ProviderCatalogDefs / ProviderCatalogSeeds / ProviderCatalogAliases /
 * ProviderCatalogDeadIDs — all codegen'd from @ranch/roost). The TS port
 * imports the canonical @ranch/roost package DIRECTLY instead of
 * porting providers_generated.go — same data, one source of truth.
 *
 * Cold start: providers carry Roost's seeds, dead-ID filtered. The Matrix
 * overlays the LIVE serving sets from the TS-exported live catalog file
 * (live-catalog.ts) — the answer, which is data. No discovery or
 * quarantine logic lives here.
 */
import {
  DEAD_MODEL_IDS,
  MODEL_ALIASES,
  PROVIDER_DEFS,
  type ModelAlias,
} from "@ranch/roost";
import { RegistryProviders, keyEnvFor } from "./registry.ts";

/** A routable provider: base URL, key envs, and its serving model set. */
export interface Provider {
  base: string;
  keyEnv: string;
  keyEnvAlt: string;
  noAuth: boolean;
  models: string[];
}

/**
 * Build the default provider table.
 *
 * Core catalog (Roost PROVIDER_DEFS, router-local/disabled skipped) wins;
 * the extended registry (registry.ts) merges in afterwards in deterministic
 * (sorted) order: core catalog wins on collision, non-openai formats and
 * empty BaseURLs are skipped.
 */
export function defaultProviders(): Record<string, Provider> {
  const dead = deadIDSet();
  const providers: Record<string, Provider> = {};
  for (const d of PROVIDER_DEFS) {
    if (d.enabled === false || d.routerLocal) continue;
    providers[d.name] = {
      base: d.baseUrl,
      keyEnv: d.keyEnv,
      keyEnvAlt: d.keyEnvAlt ?? "",
      noAuth: d.auth === "none",
      models: filterDeadIDs(d.seeds, dead),
    };
  }

  // Merge extended providers from registry (skip duplicates, skip non-openai, skip empty BaseURL)
  for (const id of Object.keys(RegistryProviders).sort()) {
    const reg = RegistryProviders[id];
    if (providers[id]) continue; // core provider takes precedence
    if (!reg.baseUrl || reg.format !== "openai") continue; // can only route openai-format providers
    providers[id] = {
      base: reg.baseUrl,
      keyEnv: keyEnvFor(id),
      keyEnvAlt: "",
      noAuth: reg.noAuth,
      models: reg.models.map((m) => m.id),
    };
  }
  return providers;
}

/** Permanent dead-tier set from Roost's DEAD_MODEL_IDS. */
export function deadIDSet(): Set<string> {
  return new Set(DEAD_MODEL_IDS);
}

/** Remove permanently-dead ids from a seed list. */
export function filterDeadIDs(ids: string[], dead: Set<string>): string[] {
  return ids.filter((id) => !dead.has(id));
}

/**
 * Whether an alias target is currently servable: not on the permanent dead
 * list, and present in the provider's current serving set (which comes from
 * the live catalog file, or Roost seeds at cold start). Quarantined models
 * are absent from the serving set, so this single membership check covers
 * both guards. Data check, not logic.
 */
export function aliasTargetServable(
  providers: Record<string, Provider>,
  prov: string,
  model: string,
): boolean {
  if (deadIDSet().has(model)) return false;
  const p = providers[prov];
  if (!p) return false;
  return p.models.includes(model);
}

/** Herd-specific aliases with NO canonical equivalent. Canonical aliases live in Roost. */
export const herdLocalAliases: Record<string, ModelAlias> = {
  // Auto routing (empty tuple means use strategy)
  auto: [] as unknown as ModelAlias,
  fcm: [] as unknown as ModelAlias,
  // Local-first ranked roles
  fast: ["herd", "local-fast"],
  "local-fast": ["herd", "local-fast"],
  quality: ["herd", "local-quality"],
  "local-quality": ["herd", "local-quality"],
  longctx: ["herd", "local-longctx"],
  "local-longctx": ["herd", "local-longctx"],
  "local-auto": ["herd", "local-quality"],
  // OpenRouter free aliases (verified working 2026-07-28)
  "gpt-oss-20b": ["openrouter", "openai/gpt-oss-20b:free"],
  // NVIDIA NIM aliases
  "nim-llama-3.3-70b": ["nvidia", "meta/llama-3.3-70b-instruct"],
  // Extended provider aliases from registry
  opencode: ["opencode", "opencode"],
  "xai-grok-4": ["xai", "grok-4"],
  "xai-grok-3": ["xai", "grok-3"],
  "mimo-auto": ["mimo-free", "mimo-auto"],
  "perplexity-sonar": ["perplexity", "sonar-pro"],
  "together-llama-3.3": ["together", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
};

/**
 * The merged alias table: Roost's canonical MODEL_ALIASES plus herd-local
 * extras. Herd-local wins on key collision.
 */
export const codingAlias: Record<string, ModelAlias> = (() => {
  const m: Record<string, ModelAlias> = {};
  for (const [k, v] of Object.entries(MODEL_ALIASES)) m[k] = v;
  for (const [k, v] of Object.entries(herdLocalAliases)) m[k] = v;
  return m;
})();

/** Known local GGUF model ID prefixes. */
const localPatterns = /^(beellama|mradermacher|jackrong|turboquant|ik_llama|ik_turboquant|holo|qwen\/|gemma-4|exaone)/;

/** Model IDs that should route to the local herd. */
export function isLocalSwapModelId(model: string): boolean {
  if (!model || model === "auto" || model === "fcm") return false;
  const target = codingAlias[model];
  if (target && target.length > 0 && target[0] === "herd") return true;
  return localPatterns.test(model);
}

/** Resolve a model name to (provider, modelID). */
export function resolveModel(
  model: string,
  providers: Record<string, Provider>,
): [string, string] {
  // Coding aliases (guarded: dead or non-serving targets refused).
  const target = codingAlias[model];
  if (target && target.length > 0 && target[0] !== "") {
    if (aliasTargetServable(providers, target[0], target[1])) {
      return [target[0], target[1]];
    }
  }
  // Local GGUF model ID
  if (isLocalSwapModelId(model)) return ["herd", model];
  // Auto/fcm: search all providers — first with a key and models
  if (model === "auto" || model === "fcm") {
    for (const [pname, p] of Object.entries(providers)) {
      if (pname === "herd") continue;
      if (p.noAuth || process.env[p.keyEnv]) {
        if (p.models.length > 0) return [pname, p.models[0]];
      }
    }
    return ["herd", "local-quality"];
  }
  // Search provider model lists
  for (const [pname, p] of Object.entries(providers)) {
    if (p.models.includes(model)) return [pname, model];
  }
  // Fallback: openrouter -> nvidia -> herd
  if (providers["openrouter"]) return ["openrouter", model];
  if (providers["nvidia"]) return ["nvidia", model];
  return ["herd", "local-quality"];
}

/** True if the model maps to a specific provider via coding aliases. */
export function isExplicit(model: string): boolean {
  const target = codingAlias[model];
  return !!target && target.length > 0 && target[0] !== "";
}

/** Detects code/AST content in responses. */
const astRe =
  /(def |class |import |from |function |const |let |var |#include|package |fn |pub |struct |impl |async |await |\.ts|\.py|\.rs|\.js|AST|tree-sitter|syntax|```)/;

export function isAST(text: string): boolean {
  if (!text) return false;
  if (text.includes("```")) return true;
  const sample = text.length > 5000 ? text.slice(0, 5000) : text;
  return astRe.test(sample);
}
