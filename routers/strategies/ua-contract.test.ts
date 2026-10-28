// UA contract (anomaly #14): Cloudflare 1010 bans library-default UAs. Every
// outbound fetch CALL in the router must carry an explicit User-Agent.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./router.ts", import.meta.url), "utf8");

describe("router UA contract", () => {
  test("no outbound fetch call without headers in router.ts", () => {
    // call-sites only: fetch( followed by a string/template/URL value
    const calls = [...src.matchAll(/fetch\(\s*[`"']/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) {
      const ctx = src.slice(m.index!, m.index! + 400);
      expect(ctx).toMatch(/headers/);
    }
  });
  test("UA is an explicit estate string, not a library default", () => {
    const uas = [...src.matchAll(/"User-Agent":\s*"([^"]+)"/g)].map(m => m[1]);
    expect(uas.length).toBeGreaterThan(0);
    for (const ua of uas) expect(ua).toMatch(/^EstateRouter\//);
  });
});
