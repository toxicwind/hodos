/**
 * Provider model — Flock's multi-provider core, ported from proxy/src/providers.rs
 * and integrated with the roost package for SSOT wire data.
 *
 * Fidelity notes (see MIGRATION.md for the full account):
 * - ProviderDef fields (name, base_url, auth, keys, no_auth, free_tier, models,
 *   model_map, weight, elo, default_rpm, display_name, enabled, context_lengths)
 *   are carried verbatim from Roost wire data merged with FLOCK_PROVIDER_OVERLAY.
 * - Key material (key/env vars) comes from Roost; resolved at call time via
 *   resolve_key_material.
 * - max_parallel is actually enforced in the router (AstMatrix declared but
 *   never enforced its declared race path).
 * - The RequestCoalescer TTL is real and sits on the buffered request path.
 * - Strategy names match AstMatrix's identifiers so existing configs keep
 *   resolving them.
 * - ProviderOverlay carries ELO/weight seeds from the hardcoded overlay;
 *   do not retune here — retuning is a deliberate separate change.
 */
import type { ProviderDef as RoostProviderDef } from "@ranch/roost";
import { PROVIDER_DEFs as roostProviderDefs } from "@ranch/roost";
import type { ProviderKey } from "./types";
import { resolveKeyMaterial } from "./key-resolver";

// ── Roost-derived overlay: ELO, weight, free-tier from the hardcoded map.
// This is the TS analogue of FLOCK_PROVIDER_OVERLAY in the Rust proxy.

const FLOCK_PROVIDER_OVERLAY: Record<string, {
  elo: i32;
  weight: f64;
  freeTier: boolean;
  defaultRpm: number;
  modelMap: Record<string, string>;
}> = {
  herd: { elo: 1600, weight: 1.0, freeTier: false, defaultRpm: 0, modelMap: {} },
  openrouter: { elo: 1500, weight: 1.0, freeTier: false, defaultRpm: 0, modelMap: {} },
  nvidia: { elo: 1550, weight: 1.2, freeTier: true, defaultRpm: 0, modelMap: { "free": "nvidia/nemotron-3-ultra-550b-a55b" } },
  groq: { elo: 1580, weight: 1.5, freeTier: true, defaultRpm: 0, modelMap: {} },
  together: { elo: 1520, weight: 1.0, freeTier: false, defaultRpm: 0, modelMap: {} },
  cerebras: { elo: 1560, weight: 1.3, freeTier: true, defaultRpm: 0, modelMap: {} },
  fireworks: { elo: 1510, weight: 1.0, freeTier: false, defaultRpm: 0, modelMap: {} },
  hyperbolic: { elo: 1490, weight: 1.0, freeTier: true, defaultRpm: 0, modelMap: {} },
  github: { elo: 1500, weight: 1.0, freeTier: true, defaultRpm: 0, modelMap: {} },
  mistral: { elo: 1530, weight: 1.0, freeTier: false, defaultRpm: 0, modelMap: {} },
  openai: { elo: 1650, weight: 1.0, freeTier: false, defaultRpm: 0, modelMap: {} },
  perplexity: { elo: 1480, weight: 1.0, freeTier: false, defaultRpm: 0, modelMap: {} },
  siliconflow: { elo: 1470, weight: 1.0, freeTier: true, defaultRpm: 0, modelMap: {} },
};

// ── Auth scheme, ported from providers.rs ─────────────────────────────────

export enum AuthScheme {
  ApiKey = "api_key",
  None = "none",
}

// ── Provider key, ported from providers.rs ─────────────────────────────────

export type ProviderKey = {
  key: string;
  keyEnv: string;
  owner: string;
  enabled: boolean;
  rpm: number;
};

export function defaultProviderKey(): ProviderKey {
  return {
    key: "",
    keyEnv: "",
    owner: "default",
    enabled: true,
    rpm: 0,
  };
}

export function resolveKeyMaterial(key: ProviderKey): string | null {
  if (key.key && key.key.trim()) {
    return key.key.trim();
  }
  if (key.keyEnv && key.keyEnv.trim()) {
    const envVal = Bun.env(key.keyEnv);
    if (envVal && envVal.trim()) {
      return envVal.trim();
    }
  }
  return null;
}

// ── Strategy, ported from providers.rs ──────────────────────────────────────

export enum Strategy {
  Hybrid = "hybrid",
  AstRace = "ast_race",
  StickyAffinity = "sticky_affinity",
  WeightedElo = "weighted_elo",
  LeastLatency = "least_latency",
  RoundRobin = "round_robin",
  Free = "free",
  CircuitChain = "circuit_chain",
}

export function strategyParse(name: string): Strategy | null {
  switch (name) {
    case "hybrid": return Strategy.Hybrid;
    case "ast_race": return Strategy.AstRace;
    case "sticky_affinity": return Strategy.StickyAffinity;
    case "weighted_elo": return Strategy.WeightedElo;
    case "least_latency": return Strategy.LeastLatency;
    case "round_robin": return Strategy.RoundRobin;
    case "free": return Strategy.Free;
    case "circuit_chain": return Strategy.CircuitChain;
    default: return null;
  }
}

// ── Routing config, ported from providers.rs ────────────────────────────────

export type RoutingCfg = {
  strategy: Strategy;
  maxParallel: number;
  maxRetries: number;
  stickyTtlSecs: number;
  fifoMax: number;
  enableCoalescing: boolean;
  probeIntervalSecs: number;
};

export function defaultRoutingCfg(): RoutingCfg {
  return {
    strategy: Strategy.Hybrid,
    maxParallel: 8,
    maxRetries: 3,
    stickyTtlSecs: 3600,
    fifoMax: 512,
    enableCoalescing: true,
    probeIntervalSecs: 30,
  };
}

// ── Provider definition, ported from providers.rs ───────────────────────────

export type ProviderDef = {
  name: string;
  baseUrl: string;
  auth: AuthScheme;
  keys: ProviderKey[];
  noAuth: boolean;
  freeTier: boolean;
  models: string[];
  modelMap: Record<string, string>;
  weight: f64;
  elo: i32;
  defaultRpm: number;
  displayName: string;
  enabled: boolean;
  contextLengths: Record<string, number>;
};

// ── Build provider defs from Roost data merged with the FLOCK overlay ───────

export function buildProviderDefs(): ProviderDef[] {
  const overlayByName = Object.fromEntries(
    Object.entries(FLOCK_PROVIDER_OVERLAY).map(([k, v]) => [k, v])
  );

  return roostProviderDefs.map((rd) => {
    const overlay = overlayByName[rd.name];
    const noAuth = rd.auth === "none";
    const freeTier = overlay.freeTier;

    // Build keys from Roost key env vars
    const keys: ProviderKey[] = [];
    if (rd.keyEnv) {
      keys.push({
        key: "",
        keyEnv: rd.keyEnv,
        owner: "default",
        enabled: true,
        rpm: 0,
      });
    }
    if (rd.keyEnvAlt) {
      keys.push({
        key: "",
        keyEnv: rd.keyEnvAlt,
        owner: "default",
        enabled: true,
        rpm: 0,
      });
    }

    // Build model map from overlay if present, otherwise empty
    const modelMap: Record<string, string> = overlay?.modelMap || {};

    // Use overlay default_rpm, falling back to Roost conventions
    const defaultRpm = overlay?.defaultRpm ?? (freeTier ? 10 : 60);

    // Map Roost seeds to models (filtering dead IDs)
    const deadIds = new Set(["gpt-oss-20b:free"]); // simplified - full list from roost
    const models = rd.seeds
      .filter((m: string) => !deadIds.has(m))
      .map((m: string) => m);

    // Context lengths from Roost
    const contextLengths: Record<string, number> = {};
    if (rd.contextLengths) {
      for (const [k, v] of Object.entries(rd.contextLengths)) {
        contextLengths[k] = v;
      }
    }

    return {
      name: rd.name,
      baseUrl: rd.baseUrl,
      auth: noAuth ? AuthScheme.None : AuthScheme.ApiKey,
      keys,
      noAuth,
      freeTier,
      models,
      modelMap,
      weight: overlay?.weight ?? rd.weight ?? 1500,
      elo: overlay?.elo ?? rd.elo ?? 1500,
      defaultRpm,
      displayName: rd.displayName ?? rd.name,
      enabled: rd.enabled ?? true,
      contextLengths,
    };
  });
}

// ── Provider set with model indexing, ported from providers.rs ─────────────

export type ProviderSet = {
  providers: ProviderDef[];
  byModel: Record<string, number[]>; // model name -> array of provider indices
};

export function providerSet(providerDefs: ProviderDef[]): ProviderSet {
  const byModel: Record<string, number[]> = {};
  for (let i = 0; i < providerDefs.length; i++) {
    const p = providerDefs[i];
    for (const m of p.models) {
      if (!byModel[m]) byModel[m] = [];
      byModel[m].push(i);
    }
    // Wildcard entry
    if (p.models.some((m) => m === "*" || m === "")) {
      if (!byModel[""]) byModel[""] = [];
      byModel[""].push(i);
    }
  }
  return { providers: providerDefs, byModel };
}

export function getProvider(set: ProviderSet, name: string): ProviderDef | undefined {
  return set.providers.find((p) => p.name === name);
}

export function candidates(set: ProviderSet, model: string): ProviderDef[] {
  const out: ProviderDef[] = [];
  const idxs = set.byModel[model] || [];
  for (const i of idxs) {
    const p = set.providers[i];
    if (!out.some((q) => q.name === p.name)) out.push(p);
  }
  // Wildcard
  const wild = set.byModel[""] || [];
  for (const i of wild) {
    const p = set.providers[i];
    if (!out.some((q) => q.name === p.name)) out.push(p);
  }
  return out;
}

export function usableCandidates(set: ProviderSet, model: string): ProviderDef[] {
  return candidates(set, model).filter((p) => p.usable());
}

export function isEnabled(p: ProviderDef): boolean {
  return p.enabled && (!p.keys.some((k) => !k.enabled) || p.noAuth);
}

// Add usable method to ProviderDef
export interface ProviderDefWithUsable extends ProviderDef {
  usable(): boolean;
}

// Extend ProviderDef with usable method
ProviderDefWithUsable.usable = function (this: ProviderDefWithUsable): boolean {
  if (!this.enabled) return false;
  if (this.noAuth || this.auth === AuthScheme.None) return true;
  return this.keys.some((k) => k.enabled && resolveKeyMaterial(k) !== null);
};

// Expose key resolution
export { resolveKeyMaterial };