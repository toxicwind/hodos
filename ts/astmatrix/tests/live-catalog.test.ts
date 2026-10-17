/**
 * Port of herd/internal/astmatrix/live_catalog_test.go (Go) to bun:test.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEAD_MODEL_IDS } from "@ranch/roost";
import { LiveCatalogReader, reportServe404 } from "../src/live-catalog.ts";
import {
  aliasTargetServable,
  deadIDSet,
  defaultProviders,
  type Provider,
} from "../src/providers.ts";

function writeLiveFile(dir: string, body: string): string {
  const p = join(dir, "catalog.live.json");
  writeFileSync(p, body);
  return p;
}

const liveDoc = `{
  "contract": "ranch-roost/live-catalog/v1",
  "generatedAt": "2026-09-30T00:00:00Z",
  "generator": "test",
  "deadIds": ["dead-1"],
  "providers": {
    "groq": {"serving": ["m-a", "m-b"], "quarantined": ["m-q"], "discovered": true},
    "openrouter": {"serving": [], "quarantined": [], "discovered": true}
  }
}`;

describe("LiveCatalogReader", () => {
  test("absent file reports no live data and leaves providers untouched", () => {
    const r = new LiveCatalogReader(join(mkdtempSync(join(tmpdir(), "lc-")), "nope.live.json"));
    expect(r.servingModels("groq").ok).toBe(false);
    const provs: Record<string, Provider> = {
      groq: { base: "", keyEnv: "", keyEnvAlt: "", noAuth: false, models: ["seed"] },
    };
    r.syncProviderModels(provs);
    expect(provs["groq"].models).toEqual(["seed"]);
  });

  test("serves the live answer", () => {
    const p = writeLiveFile(mkdtempSync(join(tmpdir(), "lc-")), liveDoc);
    const r = new LiveCatalogReader(p);
    const { models, ok } = r.servingModels("groq");
    expect(ok).toBe(true);
    expect(models).toEqual(["m-a", "m-b"]);
    expect(r.servingModels("unknown-provider").ok).toBe(false);
  });

  test("sync overlays live sets verbatim", () => {
    const p = writeLiveFile(mkdtempSync(join(tmpdir(), "lc-")), liveDoc);
    const r = new LiveCatalogReader(p);
    const provs: Record<string, Provider> = {
      groq: { base: "", keyEnv: "", keyEnvAlt: "", noAuth: false, models: ["seed-a"] },
      openrouter: { base: "", keyEnv: "", keyEnvAlt: "", noAuth: false, models: ["seed-b"] },
      nvidia: { base: "", keyEnv: "", keyEnvAlt: "", noAuth: false, models: ["seed-c"] },
    };
    r.syncProviderModels(provs);
    expect(provs["groq"].models).toEqual(["m-a", "m-b"]);
    expect(provs["openrouter"].models).toEqual([]);
    expect(provs["nvidia"].models).toEqual(["seed-c"]);
  });

  test("rejects bad contract / bad json / missing providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-"));
    const cases: Record<string, string> = {
      badjson: `{not json`,
      wrongcon: `{"contract": "something/else/v9", "providers": {}}`,
      nullproviders: `{"contract": "ranch-roost/live-catalog/v1"}`,
    };
    for (const [name, body] of Object.entries(cases)) {
      const p = writeLiveFile(dir, body);
      const r = new LiveCatalogReader(p);
      expect(r.servingModels("groq").ok).toBe(false);
    }
  });

  test("picks up mtime change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-"));
    const p = writeLiveFile(dir, liveDoc);
    const r = new LiveCatalogReader(p);
    expect(r.servingModels("groq").ok).toBe(true);
    const updated = `{
  "contract": "ranch-roost/live-catalog/v1",
  "generatedAt": "2026-09-30T01:00:00Z",
  "deadIds": [],
  "providers": {
    "groq": {"serving": ["m-a", "m-b", "m-q"], "quarantined": [], "discovered": true}
  }
}`;
    // Ensure the mtime actually advances (coarse filesystem granularity).
    await Bun.sleep(1100);
    writeLiveFile(dir, updated);
    const { models, ok } = r.servingModels("groq");
    expect(ok).toBe(true);
    expect(models).toHaveLength(3);
  });

  test("reportServe404 posts the event", async () => {
    let gotPath = "";
    let gotProvider = "";
    let gotModel = "";
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        gotPath = new URL(req.url).pathname;
        const body = (await req.json()) as { provider: string; model: string };
        gotProvider = body.provider;
        gotModel = body.model;
        return new Response("ok");
      },
    });
    const prev = process.env.estate-scripts_CATALOG_404_URL;
    process.env.estate-scripts_CATALOG_404_URL = `http://127.0.0.1:${srv.port}/admin/catalog/serve-404`;
    try {
      await reportServe404("groq", "m-gone");
      // reportServe404 awaits internally, so the post has landed.
      expect(gotPath).toBe("/admin/catalog/serve-404");
      expect(gotProvider).toBe("groq");
      expect(gotModel).toBe("m-gone");
    } finally {
      if (prev === undefined) delete process.env.estate-scripts_CATALOG_404_URL;
      else process.env.estate-scripts_CATALOG_404_URL = prev;
      srv.stop();
    }
  });
});

describe("defaultProviders", () => {
  test("skips router-local providers and dead-IDs at cold start", () => {
    const provs = defaultProviders();
    expect(provs["nim-local"]).toBeUndefined();
    expect(provs["kimi-auto"]).toBeUndefined();
    expect(provs["groq"]).toBeDefined();
    const dead = deadIDSet();
    for (const id of provs["groq"].models) {
      expect(dead.has(id)).toBe(false);
    }
  });
});

describe("aliasTargetServable", () => {
  test("guards dead, non-serving, and unknown providers", () => {
    const provs: Record<string, Provider> = {
      groq: { base: "", keyEnv: "", keyEnvAlt: "", noAuth: false, models: ["m-a"] },
    };
    expect(aliasTargetServable(provs, "groq", "m-a")).toBe(true);
    expect(aliasTargetServable(provs, "groq", "m-q")).toBe(false);
    expect(aliasTargetServable(provs, "nope", "m-a")).toBe(false);
    for (const dead of DEAD_MODEL_IDS) {
      expect(aliasTargetServable(provs, "groq", dead)).toBe(false);
    }
  });
});
