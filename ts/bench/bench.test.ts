import { describe, expect, test } from "bun:test";
import {
  DEAD_MODEL_IDS,
  ModelCatalog,
  MODEL_ALIASES,
  PROVIDER_DEFS,
} from "../../roost/src/index.ts";
import {
  BENCH_EXCLUDE,
  benchDefs,
  catalogModels,
  livenessVerdict,
  p50,
  resolveKey,
  runProvider,
  scoreQuality,
  type BenchProviderDef,
} from "./bench.ts";

/** Canonical catalog construction (mirrors the library default). */
const testCatalog = () =>
  new ModelCatalog(PROVIDER_DEFS, {
    aliases: MODEL_ALIASES,
    deadIds: DEAD_MODEL_IDS,
  });

describe("scoreQuality (0–2 sentinel scale)", () => {
  test("exact match = 2", () => expect(scoreQuality("ABSTRACT-7X3Q", "ABSTRACT-7X3Q")).toBe(2));
  test("exact match with whitespace = 2", () => expect(scoreQuality("  ABSTRACT-7X3Q\n", "ABSTRACT-7X3Q")).toBe(2));
  test("contains = 1", () => expect(scoreQuality("here: ABSTRACT-7X3Q ok", "ABSTRACT-7X3Q")).toBe(1));
  test("miss = 0", () => expect(scoreQuality("wrong token", "ABSTRACT-7X3Q")).toBe(0));
});

describe("livenessVerdict", () => {
  test("null/empty = unhealthy", () => {
    expect(livenessVerdict(null).healthy).toBe(false);
    expect(livenessVerdict("").reason).toBe("empty completion");
  });
  test("refusal markers = unhealthy", () => {
    expect(livenessVerdict("I'm sorry, I can't help with that").healthy).toBe(false);
  });
  test("plain output = healthy", () => {
    expect(livenessVerdict("PING-OK").healthy).toBe(true);
  });
});

describe("p50", () => {
  test("empty = null", () => expect(p50([])).toBeNull());
  test("median of odd set", () => expect(p50([30, 10, 20])).toBe(20));
  test("median of even set (upper)", () => expect(p50([40, 10, 30, 20])).toBe(30));
});

describe("resolveKey (pool-first, like the router)", () => {
  test("keyEnvAlt pool first non-empty wins", () => {
    const def: BenchProviderDef = { name: "n", base: "b", keyEnv: "BENCH_T_K1", keyEnvAlt: "BENCH_T_POOL" };
    process.env.BENCH_T_K1 = "single";
    process.env.BENCH_T_POOL = " , first-pool ,, second-pool ";
    expect(resolveKey(def)).toBe("first-pool");
    delete process.env.BENCH_T_K1;
    delete process.env.BENCH_T_POOL;
  });
  test("falls back to keyEnv when pool empty", () => {
    const def: BenchProviderDef = { name: "n", base: "b", keyEnv: "BENCH_T_K2", keyEnvAlt: "BENCH_T_POOL2" };
    process.env.BENCH_T_K2 = "fallback";
    process.env.BENCH_T_POOL2 = "  ";
    expect(resolveKey(def)).toBe("fallback");
    delete process.env.BENCH_T_K2;
    delete process.env.BENCH_T_POOL2;
  });
});

describe("benchDefs (Roost-backed)", () => {
  test("excluded providers are not benched", () => {
    const defs = benchDefs(testCatalog());
    for (const name of BENCH_EXCLUDE) expect(defs[name]).toBeUndefined();
  });
  test("every def has base + keyEnv", () => {
    const defs = benchDefs(testCatalog());
    expect(Object.keys(defs).length).toBeGreaterThan(0);
    for (const d of Object.values(defs)) {
      expect(d.base.length).toBeGreaterThan(0);
      expect(d.keyEnv.length).toBeGreaterThan(0);
    }
  });
});

describe("runProvider/catalogModels error surface", () => {
  test("unknown provider throws", async () => {
    const defs = benchDefs(testCatalog());
    await expect(runProvider("nope", { reqs: 1, concurrency: 1, timeoutMs: 100 }, defs)).rejects.toThrow(
      "unknown provider"
    );
    await expect(catalogModels("nope", defs)).rejects.toThrow("unknown provider");
  });
  test("missing key env throws", async () => {
    const defs: Record<string, BenchProviderDef> = {
      nokey: { name: "nokey", base: "http://127.0.0.1:1", keyEnv: "BENCH_T_ABSENT_KEY_XYZ" },
    };
    await expect(runProvider("nokey", { reqs: 1, concurrency: 1, timeoutMs: 100 }, defs)).rejects.toThrow(
      "not set"
    );
  });
});
