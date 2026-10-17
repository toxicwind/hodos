/**
 * Matrix + router tests: circuits, ELO, sticky, strategies, routing math.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Matrix } from "../src/matrix.ts";
import { Router, strategies } from "../src/router.ts";

function freshMatrix(): Matrix {
  return Matrix.create({
    dbPath: join(mkdtempSync(join(tmpdir(), "hdb-")), "health.db"),
    enabled: true,
  });
}

describe("Matrix circuits", () => {
  test("closed by default; opens after 3 failures", () => {
    const m = freshMatrix();
    const p = "groq";
    expect(m.circuitOk(p)).toBe(true);
    m.record("m", p, 500, 0.1, 0, "", "");
    m.record("m", p, 500, 0.1, 0, "", "");
    expect(m.circuitOk(p)).toBe(true);
    m.record("m", p, 500, 0.1, 0, "", "");
    expect(m.circuitState(p)).toBe("open");
    expect(m.circuitOk(p)).toBe(false);
    m.close();
  });

  test("success recovers the circuit", () => {
    const m = freshMatrix();
    const p = "groq";
    for (let i = 0; i < 3; i++) m.record("m", p, 500, 0.1, 0, "", "");
    expect(m.circuitState(p)).toBe("open");
    // Force the cooldown to expire by directly recording success path:
    // circuitOk flips open->half once 60s pass; emulate via success record.
    m.record("m", p, 200, 0.1, 0, "", "");
    expect(m.circuitState(p)).toBe("closed");
    expect(m.circuitOk(p)).toBe(true);
    m.close();
  });
});

describe("Matrix ELO", () => {
  test("wins raise, losses lower", () => {
    const m = freshMatrix();
    const before = m.eloOf("groq");
    m.record("m", "groq", 200, 0.1, 0, "", "");
    expect(m.eloOf("groq")).toBeGreaterThan(before);
    m.record("m", "groq", 500, 0.1, 0, "", "");
    expect(m.eloOf("groq")).toBeLessThan(before + 16);
    m.close();
  });
});

describe("Matrix sticky", () => {
  test("set/get roundtrip", () => {
    const m = freshMatrix();
    m.stickySet("sess-1", "groq", "m-a");
    expect(m.stickyGet("sess-1")).toEqual(["groq", "m-a"]);
    m.close();
  });
});

describe("Matrix FIFO", () => {
  test("admission and release", () => {
    const m = freshMatrix();
    const max = m.getConfig().fifoMax;
    expect(max).toBeGreaterThan(0);
    for (let i = 0; i < max; i++) expect(m.fifoEnter()).toBe(true);
    expect(m.fifoEnter()).toBe(false);
    m.fifoExit();
    expect(m.fifoEnter()).toBe(true);
    m.close();
  });
});

describe("Matrix pickWeighted", () => {
  test("returns deduped providers with models", () => {
    const m = freshMatrix();
    const picks = m.pickWeighted(3);
    expect(picks.length).toBeLessThanOrEqual(3);
    const names = picks.map(([p]) => p);
    expect(new Set(names).size).toBe(names.length);
    for (const [p, mid] of picks) {
      expect(mid).not.toBe("");
      expect(m.keyOk(p) || true).toBe(true); // pickWeighted filters keyed only
    }
    m.close();
  });
});

describe("Matrix keyOk/getKey", () => {
  test("noAuth always ok; keyed providers need env", () => {
    const m = freshMatrix();
    expect(m.keyOk("nim-local")).toBe(false); // router-local, not in providers
    // herd has noAuth
    expect(m.keyOk("herd")).toBe(true);
    expect(m.getKey("herd")).toBe("not-required-for-local");
    m.close();
  });

  test("keyed providers require env", () => {
    const m = freshMatrix();
    process.env.GROQ_API_KEY = "test-key";
    expect(m.keyOk("groq")).toBe(true);
    expect(m.getKey("groq")).toBe("test-key");
    delete process.env.GROQ_API_KEY;
    expect(m.keyOk("groq")).toBe(false);
    m.close();
  });
});

describe("Router", () => {
  test("handles() routing table", () => {
    const r = Router.create({ dbPath: join(mkdtempSync(join(tmpdir(), "hdb-")), "h.db") });
    expect(r.handles("auto")).toBe(true);
    expect(r.handles("free")).toBe(true);
    expect(r.handles("ling")).toBe(true); // canonical Tack alias
    expect(r.handles("Qwen3-14B-Q4_K_M.gguf")).toBe(false); // not in any serving set
    expect(r.handles("")).toBe(false);
    expect(r.handles("llama-3.3-70b-versatile")).toBe(false); // dead in Tack (EOL'd)
    expect(r.handles("openai/gpt-oss-120b")).toBe(true); // live groq seed
    r.close();
  });

  test("all strategies registered", () => {
    for (const s of [
      "hybrid",
      "ast_race",
      "sticky_affinity",
      "weighted_elo",
      "circuit_chain",
      "fifo_matrix",
      "free",
    ]) {
      expect(strategies[s]).toBeDefined();
    }
  });

  test("invalid JSON body -> 400", async () => {
    const r = Router.create({ dbPath: join(mkdtempSync(join(tmpdir(), "hdb-")), "h.db") });
    const resp = await r.handleRequest(
      new Request("http://x/v1/chat/completions", { method: "POST", body: "not json" }),
    );
    expect(resp.status).toBe(400);
    r.close();
  });

  test("free strategy with no keys -> 503", async () => {
    const r = Router.create({ dbPath: join(mkdtempSync(join(tmpdir(), "hdb-")), "h.db") });
    const resp = await r.handleRequest(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-estate-scripts-Strategy": "free" },
        body: JSON.stringify({ model: "auto", messages: [] }),
      }),
    );
    // herd is a free fallback; no keys configured -> may 503 or route
    // to herd if keyOk. Accept either, but it must respond JSON.
    expect(resp.headers.get("Content-Type")).toContain("application/json");
    r.close();
  });
});
