import { describe, expect, test } from "bun:test";
import {
  DEAD_MODEL_IDS,
  ModelCatalog,
  MODEL_ALIASES,
  PROVIDER_DEFS,
} from "../../roost/src/index.ts";
import {
  LIVE_MODEL_META,
  LIVE_STATUS,
  refreshLiveModels,
  slimMeta,
  type LiveDiscoveryDeps,
} from "./live-models.ts";

function deps(): LiveDiscoveryDeps {
  return {
    catalog: new ModelCatalog(PROVIDER_DEFS, {
      aliases: MODEL_ALIASES,
      deadIds: DEAD_MODEL_IDS,
    }),
    keyOk: () => false, // no keys in test env — every provider gets no_key
    log: () => {},
  };
}

describe("slimMeta", () => {
  test("drops description, keeps the rest", () => {
    const out = slimMeta({
      description: "long prose about the model",
      id: "m",
      context_length: 128000,
      pricing: { prompt: "0.1" },
    });
    expect(out.description).toBeUndefined();
    expect(out.context_length).toBe(128000);
    expect(out.id).toBe("m");
  });
  test("handles missing description", () => {
    expect(slimMeta({ id: "m" })).toEqual({ id: "m" });
  });
});

describe("refreshLiveModels (no keys — no network)", () => {
  test("every provider gets a no_key status, never throws", async () => {
    const d = deps();
    await refreshLiveModels(d);
    const names = d.catalog.providerNames();
    expect(names.length).toBeGreaterThan(0);
    for (const p of names) {
      expect(LIVE_STATUS[p]).toBeDefined();
      expect(LIVE_STATUS[p]!.ok).toBe(false);
      expect(LIVE_STATUS[p]!.error).toBe("no_key");
    }
  });

  test("singleflight dedupes concurrent triggers", async () => {
    const d = deps();
    const a = refreshLiveModels(d);
    const b = refreshLiveModels(d);
    expect(a === b).toBe(true);
    await Promise.all([a, b]);
    // second run after completion is a fresh promise
    expect(refreshLiveModels(d) === a).toBe(false);
    await refreshLiveModels(d);
  });
});

describe("LIVE_MODEL_META shape", () => {
  test("is a record keyed by provider then model id", () => {
    expect(typeof LIVE_MODEL_META).toBe("object");
  });
});
