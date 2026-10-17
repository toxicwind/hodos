/**
 * @flock/strategy regression tests.
 *
 * Strategy functions are pure against StrategyDeps; tests build a stub deps
 * backed by the REAL policy tier (EloEngine, CircuitPolicy, PolicyHealthDB
 * on a throwaway DB) plus a fixture catalog, so the composition is what's
 * under test — not a re-mock of the policy.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EloEngine } from "../policy/elo.ts";
import { CircuitPolicy } from "../policy/circuit.ts";
import { PolicyHealthDB } from "../policy/health.ts";
import {
  isExplicit,
  LOCAL_ROLES,
  normalizeModelSpec,
  resolveModel,
  type CatalogQuery,
} from "./catalog.ts";
import {
  PolicyBackedDeps,
} from "./deps.ts";
import {
  LONGCTX_PIN_GATE_TOKENS,
  bindStrategies,
  estPromptTokens,
  firstUsableModelFor,
  freeCandidates,
  isRoutableModelId,
  longctxPinEligible,
  modelProbeBonus,
  pickWeighted,
  substantive,
} from "./strategy.ts";
import type { ChatBody, ProviderView, RouteResult, StrategyDeps } from "./types.ts";

// ---------------------------------------------------------------------------
// Fixture catalog
// ---------------------------------------------------------------------------
const MODELS: Record<string, string[]> = {
  "herd": ["beellama/qwen-flash-64k", "beellama/exaone-4-0-1-2b-iq4xs"],
  nvidia: ["nvidia/nemotron-3-super-120b-a12b", "nvidia/gpt-oss-20b"],
  openrouter: [
    "inclusionai/ling-3.0-flash-fin:free",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-20b:free",
  ],
};
const VIEWS: ProviderView[] = [
  { name: "herd", baseUrl: "http://127.0.0.1:25100", keyEnv: "X", noAuth: true },
  { name: "nvidia", baseUrl: "https://integrate.api.nvidia.com", keyEnv: "NVIDIA_API_KEY", keyEnvAlt: "NVIDIA_API_KEYS" },
  { name: "openrouter", baseUrl: "https://openrouter.ai/api", keyEnv: "OPENROUTER_API_KEY" },
];
const META: Record<string, Record<string, Record<string, unknown>>> = {
  openrouter: {
    "inclusionai/ling-3.0-flash-fin:free": {
      pricing: { prompt: "0", completion: "0" },
    },
  },
};
const CODING: Record<string, [string, string] | null> = {
  auto: null,
  fast: ["herd", "beellama/exaone-4-0-1-2b-iq4xs"],
  free: null,
};

function stubDeps(): StrategyDeps & {
  elo: EloEngine;
  circuit: CircuitPolicy;
  health: PolicyHealthDB;
} {
  const dir = mkdtempSync(join(tmpdir(), "flock-strategy-test-"));
  const elo = new EloEngine();
  const circuit = new CircuitPolicy();
  const health = new PolicyHealthDB(join(dir, "health.db"));
  for (const p of VIEWS.map((v) => v.name)) circuit.register(p);
  const deps = {
    elo,
    circuit,
    health,
    providers: () => VIEWS,
    servingModels: (p: string) => MODELS[p] ?? [],
    liveMeta: (p: string) => META[p] ?? {},
    keyOk: () => true,
    resolveKey: () => "test-key",
    circuitOk: (p: string) => circuit.circuitOk(p),
    laneDead: (p: string) => circuit.laneDead(p),
    consecutiveFailures: (p: string) => circuit.consecutiveFailures(p),
    candidateScore: (p: string) => elo.candidateScore(p),
    isEntitlementDead: (p: string, m: string) => circuit.isEntitlementDead(p, m),
    flapBanned: (p: string, m: string) => circuit.flapBanned(p, m),
    recordEmpty: (p: string, m: string) => circuit.recordEmpty(p, m),
    record: (
      model: string,
      provider: string,
      status: number,
      latSec: number,
      winner = 0,
      strategy = "",
      session = "",
      estTokens = 0,
    ) => {
      health.recordRequest(provider, model, status, latSec * 1000, strategy, winner, session, estTokens);
      elo.recordOutcome(provider, status, latSec * 1000);
      circuit.recordOutcome(provider, model, status);
    },
    noteError: (p: string, s: number, e: string) => circuit.noteError(p, s, e),
    noteWorkerExhausted: () => {},
    stickyGet: (s: string) => health.stickyGet(s),
    stickySet: (s: string, p: string, m: string) => health.stickySet(s, p, m),
    countStrategyToday: (s: string) => {
      const row = health.conn
        .query(
          `SELECT COUNT(*) AS n FROM requests WHERE strategy=? AND ts >= strftime('%s','now','start of day')`,
        )
        .get(s) as { n: number } | null;
      return row?.n || 0;
    },
    governorAdmit: () => ({ release: () => {} }),
    fifoDepth: 0,
    strategyName: "hybrid",
    log: (..._a: unknown[]) => {},
    resolveSpec: (spec: string): [string, string] => {
      const q: CatalogQuery = {
        providerNames: () => VIEWS.map((v) => v.name),
        servingModels: (p: string) => MODELS[p] ?? [],
        isQuarantined: () => false,
        deadIds: () => new Set(),
        keyOk: () => true,
      };
      return resolveModel(spec, q, CODING);
    },
    isRoutableModelId: (model: string): boolean => {
      if (!model) return false;
      const q: CatalogQuery = {
        providerNames: () => VIEWS.map((v) => v.name),
        servingModels: (p: string) => MODELS[p] ?? [],
        isQuarantined: () => false,
        deadIds: () => new Set(),
        keyOk: () => true,
      };
      if (isExplicit(model, CODING)) return true;
      if (normalizeModelSpec(model, q, CODING).provider) return true;
      for (const p of q.providerNames()) {
        if (q.servingModels(p).includes(model)) return true;
      }
      return false;
    },
    _cleanup: () => rmSync(dir, { recursive: true, force: true }),
  } as StrategyDeps & { _cleanup: () => void } & {
    elo: EloEngine;
    circuit: CircuitPolicy;
    health: PolicyHealthDB;
  };
  return deps;
}

// ---------------------------------------------------------------------------
// substantive
// ---------------------------------------------------------------------------
describe("substantive", () => {
  const ok = (content: unknown): RouteResult => ({
    ok: true,
    status: 200,
    data: new TextEncoder().encode(
      JSON.stringify({ choices: [{ message: { content } }] }),
    ),
  });

  test("non-empty text completion is substantive", () => {
    expect(substantive(ok("hello world"))).toBe(true);
  });
  test("whitespace-only completion is not substantive", () => {
    expect(substantive(ok("   \n  "))).toBe(false);
  });
  test("empty completion is not substantive", () => {
    expect(substantive(ok(""))).toBe(false);
  });
  test("failed result is not substantive", () => {
    expect(substantive({ ok: false, status: 500, err: "boom" })).toBe(false);
  });
  test("tool_calls count as substantive even with empty content", () => {
    expect(
      substantive({
        ok: true,
        status: 200,
        data: new TextEncoder().encode(
          JSON.stringify({
            choices: [{ message: { content: "", tool_calls: [{ id: "1" }] } }],
          }),
        ),
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// estPromptTokens / modelProbeBonus / normalizeModelSpec
// ---------------------------------------------------------------------------
describe("catalog helpers", () => {
  test("estPromptTokens counts string content and text parts, /4", () => {
    const body: ChatBody = {
      messages: [
        { role: "user", content: "x".repeat(400) },
        {
          role: "user",
          content: [{ type: "text", text: "y".repeat(200) }, { type: "image" }],
        },
      ],
    };
    expect(estPromptTokens(body)).toBe(150);
  });
  test("estPromptTokens is 0 with no messages", () => {
    expect(estPromptTokens({})).toBe(0);
  });

  test("modelProbeBonus rewards the 1M-verified nemotron pair", () => {
    expect(modelProbeBonus("nvidia", "nvidia/nemotron-3-super-120b-a12b")).toBe(5);
    expect(modelProbeBonus("nvidia", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")).toBe(5);
    expect(modelProbeBonus("nvidia", "nvidia/gpt-oss-20b")).toBe(0);
    expect(modelProbeBonus("openrouter", "inclusionai/ling-3.0-flash-fin:free")).toBe(0);
  });
  test("modelProbeBonus is killed by estate-scripts_MODEL_BONUS=0", () => {
    process.env.estate-scripts_MODEL_BONUS = "0";
    try {
      expect(modelProbeBonus("nvidia", "nvidia/nemotron-3-super-120b-a12b")).toBe(0);
    } finally {
      delete process.env.estate-scripts_MODEL_BONUS;
    }
  });

  const q: CatalogQuery = {
    providerNames: () => ["nvidia", "openrouter"],
    servingModels: (p: string) => MODELS[p] ?? [],
    isQuarantined: () => false,
    deadIds: () => new Set(),
    keyOk: () => true,
  };

  test("normalizeModelSpec: provider:model pins the provider", () => {
    expect(normalizeModelSpec("nvidia:gpt-oss-20b", q, CODING)).toEqual({
      provider: "nvidia",
      model: "nvidia/gpt-oss-20b",
    });
  });
  test("normalizeModelSpec: provider/model slash form", () => {
    expect(
      normalizeModelSpec("openrouter/openai/gpt-oss-20b:free", q, CODING),
    ).toEqual({ provider: "openrouter", model: "openai/gpt-oss-20b:free" });
  });
  test("normalizeModelSpec: aliases pass through untouched", () => {
    expect(normalizeModelSpec("fast", q, CODING)).toEqual({
      provider: null,
      model: "fast",
    });
  });
  test("normalizeModelSpec: bare catalog id is provider-agnostic", () => {
    expect(
      normalizeModelSpec("inclusionai/ling-3.0-flash-fin:free", q, CODING),
    ).toEqual({ provider: null, model: "inclusionai/ling-3.0-flash-fin:free" });
  });
});

// ---------------------------------------------------------------------------
// isRoutableModelId
// ---------------------------------------------------------------------------
describe("isRoutableModelId", () => {
  const deps = stubDeps();
  test("alias is routable", () => {
    expect(isRoutableModelId(deps, "fast")).toBe(true);
  });
  test("provider:model spec is routable", () => {
    expect(isRoutableModelId(deps, "nvidia:gpt-oss-20b")).toBe(true);
  });
  test("bare catalog id is routable", () => {
    expect(
      isRoutableModelId(deps, "inclusionai/ling-3.0-flash-fin:free"),
    ).toBe(true);
  });
  test("unknown id is not routable", () => {
    expect(isRoutableModelId(deps, "zzz-no-such-model")).toBe(false);
  });
  (deps as unknown as { _cleanup: () => void })._cleanup();
});

// ---------------------------------------------------------------------------
// pickWeighted / freeCandidates / firstUsableModelFor
// ---------------------------------------------------------------------------
describe("candidate selection", () => {
  test("pickWeighted appends the herd bonus lane", () => {
    const deps = stubDeps();
    try {
      const cands = pickWeighted(deps, 4);
      const names = cands.map(([p]) => p);
      expect(names).toContain("herd");
      // no duplicate providers in the cut
      expect(new Set(names).size).toBe(names.length);
    } finally {
      (deps as unknown as { _cleanup: () => void })._cleanup();
    }
  });

  test("pickWeighted excludes dead lanes (degraded fallback keeps one lane)", () => {
    const deps = stubDeps();
    try {
      // Burn every lane: enough failures to trip laneDead on all providers.
      for (const p of ["nvidia", "openrouter"]) {
        for (let i = 0; i < 8; i++)
          deps.circuit.recordOutcome(p, "m", 500);
      }
      const cands = pickWeighted(deps, 4);
      const names = cands.map(([p]) => p);
      // Degraded mode: dead lanes race anyway rather than 503.
      expect(cands.length).toBeGreaterThan(0);
      expect(names).toContain("herd");
    } finally {
      (deps as unknown as { _cleanup: () => void })._cleanup();
    }
  });

  test("freeCandidates is ling-first and excludes pay models", () => {
    const deps = stubDeps();
    try {
      const cands = freeCandidates(deps);
      // ling leads
      expect(cands[0]).toEqual([
        "openrouter",
        "inclusionai/ling-3.0-flash-fin:free",
      ]);
      // pay model without :free suffix and without zero pricing sits out
      expect(cands).not.toContainEqual(["openrouter", "openai/gpt-oss-20b"]);
      // local roles always join (zero cost) — asserted against the real
      // LOCAL_ROLES (reads /home/toxic/estate/.state/best-models.json on
      // yote, defaults elsewhere), so this holds in any environment
      expect(cands).toContainEqual(["herd", LOCAL_ROLES.fast]);
      expect(cands).toContainEqual(["herd", LOCAL_ROLES.quality]);
      expect(cands).toContainEqual(["herd", LOCAL_ROLES.longctx]);
    } finally {
      (deps as unknown as { _cleanup: () => void })._cleanup();
    }
  });

  test("firstUsableModelFor skips entitlement-benched ids", () => {
    const deps = stubDeps();
    try {
      deps.circuit.noteEntitlement404(
        "openrouter",
        "inclusionai/ling-3.0-flash-fin:free",
      );
      const mid = firstUsableModelFor(deps, "openrouter");
      expect(mid).toBe("openai/gpt-oss-20b");
    } finally {
      (deps as unknown as { _cleanup: () => void })._cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// longctx pin eligibility
// ---------------------------------------------------------------------------
describe("longctxPinEligible", () => {
  const bigBody = (chars: number): ChatBody => ({
    messages: [{ role: "user", content: "x".repeat(chars) }],
  });

  test("disabled kill switch", () => {
    const deps = stubDeps();
    try {
      process.env.estate-scripts_LONGCTX_PIN = "0";
      const v = longctxPinEligible(deps, bigBody(LONGCTX_PIN_GATE_TOKENS * 4 + 4));
      expect(v.ok).toBe(false);
      expect(v.reason).toBe("disabled");
    } finally {
      delete process.env.estate-scripts_LONGCTX_PIN;
      (deps as unknown as { _cleanup: () => void })._cleanup();
    }
  });

  test("under gate", () => {
    const deps = stubDeps();
    try {
      const v = longctxPinEligible(deps, { messages: [{ role: "user", content: "hi" }] });
      expect(v.ok).toBe(false);
      expect(v.reason).toBe("under_gate");
    } finally {
      (deps as unknown as { _cleanup: () => void })._cleanup();
    }
  });

  test("explicit model request is never hijacked", () => {
    const deps = stubDeps();
    try {
      const v = longctxPinEligible(deps, {
        model: "fast",
        ...bigBody(LONGCTX_PIN_GATE_TOKENS * 4 + 4),
      });
      expect(v.ok).toBe(false);
      expect(v.reason).toBe("explicit_model");
    } finally {
      (deps as unknown as { _cleanup: () => void })._cleanup();
    }
  });

  test("open circuit falls through to the race", () => {
    const deps = stubDeps();
    try {
      for (let i = 0; i < 8; i++)
        deps.circuit.recordOutcome("nvidia", "m", 500);
      const v = longctxPinEligible(deps, bigBody(LONGCTX_PIN_GATE_TOKENS * 4 + 4));
      expect(v.ok).toBe(false);
      expect(v.reason).toBe("circuit_open");
    } finally {
      (deps as unknown as { _cleanup: () => void })._cleanup();
    }
  });

  test("eligible when gate tripped and everything is healthy", () => {
    const deps = stubDeps();
    try {
      const v = longctxPinEligible(deps, bigBody(LONGCTX_PIN_GATE_TOKENS * 4 + 4));
      expect(v.ok).toBe(true);
      expect(v.reason).toBe("eligible");
      expect(v.estTokens).toBeGreaterThan(LONGCTX_PIN_GATE_TOKENS);
    } finally {
      (deps as unknown as { _cleanup: () => void })._cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// PolicyBackedDeps composition smoke test
// ---------------------------------------------------------------------------
describe("PolicyBackedDeps", () => {
  test("builds over the real policy tier + roost catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-deps-test-"));
    try {
      const deps = new PolicyBackedDeps({
        dbPath: join(dir, "health.db"),
        governorPath: null,
      });
      expect(deps.strategyName).toBe("hybrid");
      // alias resolution works through the real CODING table
      expect(deps.isRoutableModelId("fast")).toBe(true);
      // "auto"/"free" are strategy aliases, not model ids — not routable
      // (matches the original router_strategy.ts isRoutableModelId)
      expect(deps.isRoutableModelId("auto")).toBe(false);
      // unknown id is not routable
      expect(deps.isRoutableModelId("zzz-no-such-model")).toBe(false);
      // bindStrategies returns the full ROUTERS surface
      const routers = bindStrategies(deps);
      for (const name of [
        "fifo_matrix", "fifo_flock", "ast_race", "flock_race",
        "sticky_affinity", "weighted_elo", "circuit_chain",
        "hybrid", "free", "cascade",
      ]) {
        expect(typeof routers[name]).toBe("function");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
