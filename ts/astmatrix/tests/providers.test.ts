/**
 * Tack-integration tests for providers.ts — the TS port replaces
 * providers_generated.go with a live @ranch/roost import.
 */
import { describe, expect, test } from "bun:test";
import {
  MODEL_ALIASES,
  PROVIDER_DEFS,
  type ModelAlias,
} from "@ranch/roost";
import {
  aliasTargetServable,
  codingAlias,
  deadIDSet,
  defaultProviders,
  filterDeadIDs,
  herdLocalAliases,
  isAST,
  isExplicit,
  isLocalSwapModelId,
  resolveModel,
} from "../src/providers.ts";
import { RegistryProviders } from "../src/registry.ts";

describe("tack parity", () => {
  test("defaultProviders mirrors PROVIDER_DEFS names (minus router-local)", () => {
    const provs = defaultProviders();
    const routerLocal = new Set(
      PROVIDER_DEFS.filter((d) => d.routerLocal).map((d) => d.name),
    );
    expect(routerLocal.has("nim-local")).toBe(true);
    expect(routerLocal.has("kimi-auto")).toBe(true);
    for (const d of PROVIDER_DEFS) {
      if (routerLocal.has(d.name) || d.enabled === false) {
        expect(provs[d.name]).toBeUndefined();
      } else {
        expect(provs[d.name]).toBeDefined();
      }
    }
    // Registry-only providers merge in (openai format, non-empty base)
    expect(provs["blackbox"]).toBeDefined();
    // Non-openai format registry entries stay out
    expect(provs["anthropic"]).toBeDefined(); // anthropic is in Tack core too
    // herd is noAuth
    expect(provs["herd"].noAuth).toBe(true);
    expect(provs["groq"].keyEnv).toBe("GROQ_API_KEY");
    expect(provs["nvidia"].keyEnvAlt).toBe("NVIDIA_API_KEYS");
  });

  test("no dead model IDs leak into serving sets", () => {
    const dead = deadIDSet();
    expect(dead.size).toBeGreaterThan(0);
    const provs = defaultProviders();
    for (const [name, p] of Object.entries(provs)) {
      for (const mid of p.models) {
        expect(dead.has(mid), `${name}/${mid} should be dead`).toBe(false);
      }
    }
  });

  test("MODEL_ALIASES values are [provider, model] pairs", () => {
    for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
      expect(Array.isArray(target), alias).toBe(true);
      const [prov, mid] = target as ModelAlias;
      expect(typeof prov).toBe("string");
      expect(typeof mid).toBe("string");
      expect(prov.length).toBeGreaterThan(0);
      expect(mid.length).toBeGreaterThan(0);
    }
  });

  test("filterDeadIDs removes known dead IDs", () => {
    const sample = Array.from(deadIDSet()).slice(0, 3);
    expect(sample.length).toBeGreaterThan(0);
    expect(filterDeadIDs([...sample, "alive-model"], deadIDSet())).toEqual(["alive-model"]);
  });

  test("registry merge is deterministic and core wins", () => {
    const a = defaultProviders();
    const b = defaultProviders();
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    // "groq" exists in both Tack core and registry: core wins (models = Tack seeds, not registry's)
    const tackGroq = PROVIDER_DEFS.find((d) => d.name === "groq")!;
    expect(a["groq"].models).toEqual(
      tackGroq.seeds.filter((s) => !deadIDSet().has(s)),
    );
    expect(a["groq"].models.length).toBeGreaterThan(1);
    expect(RegistryProviders["groq"].models).toHaveLength(1);
  });
});

describe("codingAlias merge", () => {
  test("canonical tack aliases present, herd-local wins on collision", () => {
    expect(codingAlias["ling"]).toEqual(["openrouter", "inclusionai/ling-3.0-flash-fin:free"]);
    // herd-local extras
    expect(codingAlias["quality"]).toEqual(["herd", "local-quality"]);
    expect(codingAlias["gpt-oss-20b"]).toEqual(["openrouter", "openai/gpt-oss-20b:free"]);
    // auto/fcm are empty tuples (strategy directives)
    expect(codingAlias["auto"] as unknown as unknown[]).toEqual([]);
    expect(codingAlias["fcm"] as unknown as unknown[]).toEqual([]);
    expect(Object.keys(herdLocalAliases).length).toBeGreaterThan(0);
  });
});

describe("resolveModel", () => {
  test("seed model found in provider lists", () => {
    const provs = defaultProviders();
    expect(resolveModel("openai/gpt-oss-120b", provs)).toEqual([
      "groq",
      "openai/gpt-oss-120b",
    ]);
  });
  test("canonical alias target served", () => {
    const provs = defaultProviders();
    expect(resolveModel("ling", provs)).toEqual([
      "openrouter",
      "inclusionai/ling-3.0-flash-fin:free",
    ]);
  });
  test("herd-local alias resolves", () => {
    const provs = defaultProviders();
    expect(resolveModel("quality", provs)).toEqual(["herd", "local-quality"]);
  });
  test("local gguf prefix is a passthrough", () => {
    const provs = defaultProviders();
    expect(resolveModel("qwen/Qwen3-14B-Q4_K_M.gguf", provs)).toEqual([
      "herd",
      "qwen/Qwen3-14B-Q4_K_M.gguf",
    ]);
  });
  test("auto falls back deterministically", () => {
    const provs = defaultProviders();
    const [p, m] = resolveModel("auto", provs);
    expect(p).not.toBe("");
    expect(m).not.toBe("");
  });
  test("unknown falls to openrouter -> nvidia -> herd", () => {
    const provs = defaultProviders();
    expect(resolveModel("nope/never", provs)[0]).toBe("openrouter");
  });
});

describe("isExplicit", () => {
  test("aliases are explicit; auto/fcm and bare names are not", () => {
    expect(isExplicit("ling")).toBe(true);
    expect(isExplicit("quality")).toBe(true);
    expect(isExplicit("auto")).toBe(false);
    expect(isExplicit("fcm")).toBe(false);
    expect(isExplicit("groq/llama-3.3-70b-versatile")).toBe(false);
    expect(isExplicit("llama-3.3-70b-versatile")).toBe(false);
  });
});

describe("isLocalSwapModelId", () => {
  test("prefix patterns and herd aliases", () => {
    expect(isLocalSwapModelId("qwen/Qwen3-14B-Q4_K_M.gguf")).toBe(true);
    expect(isLocalSwapModelId("mradermacher/foo")).toBe(true);
    expect(isLocalSwapModelId("quality")).toBe(true);
    expect(isLocalSwapModelId("auto")).toBe(false);
    expect(isLocalSwapModelId("")).toBe(false);
    expect(isLocalSwapModelId("openai/gpt-5")).toBe(false);
    expect(isLocalSwapModelId("ling")).toBe(false);
  });
});

describe("isAST", () => {
  test("rejects prose, accepts code (mirrors Go astRe)", () => {
    expect(isAST("")).toBe(false);
    expect(isAST("Sure, here's what you can do: follow the steps below.")).toBe(false);
    expect(isAST("def hello():\n    return 42")).toBe(true);
    expect(isAST("```python\nprint('hi')\n```")).toBe(true);
    expect(isAST("use tree-sitter to parse the syntax")).toBe(true);
    expect(isAST("x".repeat(6000))).toBe(false);
  });
});

describe("aliasTargetServable", () => {
  test("unknown provider is not servable; served model is", () => {
    const provs = defaultProviders();
    expect(aliasTargetServable(provs, "nope", "m")).toBe(false);
    expect(aliasTargetServable(provs, "openrouter", "inclusionai/ling-3.0-flash-fin:free")).toBe(true);
    for (const dead of deadIDSet()) {
      expect(aliasTargetServable(provs, "groq", dead)).toBe(false);
    }
  });
});
