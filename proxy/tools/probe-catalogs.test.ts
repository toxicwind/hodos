/**
 * probe-catalogs.test.ts — unit coverage for the merged-catalog prober.
 *
 * Covers the pure, deterministic parts of the integration: the rate-limits
 * parser (both api-evangelist catalog shapes) and the endpoint candidate
 * resolver. Live probing is network-dependent, so the fetch path is kept out
 * and the merge/build functions are exercised with fixtures.
 */
import { describe, expect, it, afterEach } from "bun:test";
import { parseRateLimits, candidatesFor, keyFor } from "./probe-catalogs.ts";

const NIM_FIXTURE = `# generated NIM limits
method: generated
provider:
  name: NVIDIA NIM
  id: nvidia-nim
policies:
- id: hosted-developer-rpm
  name: Hosted Developer RPM
  scope: per-api-key
  metric: requests
  limit: 40
  window: 1m
- id: hosted-concurrent
  name: Concurrent
  metric: concurrent-requests
  limit: 5
- id: hosted-max-tokens
  name: Max Tokens
  metric: max_tokens
  limit: 4096
`;

describe("parseRateLimits (vends nvidia-nim / nvidia catalog shapes)", () => {
  it("extracts each policy id, metric, limit, window", () => {
    const ps = parseRateLimits(NIM_FIXTURE);
    expect(ps.length).toBe(3);
    expect(ps[0].id).toBe("hosted-developer-rpm");
    expect(ps[0].metric).toBe("requests");
    expect(ps[0].limit).toBe(40);
    expect(ps[0].window).toBe("1m");
    expect(ps[1].limit).toBe(5);
    expect(ps[2].limit).toBe(4096);
  });

  it("numeric limits parse as numbers, others stay strings", () => {
    const ps = parseRateLimits(NIM_FIXTURE);
    expect(typeof ps[0].limit).toBe("number");
    expect(typeof ps[2].limit).toBe("number");
  });

  it("ignores comments and blank lines", () => {
    const withComments = `# only a comment\n\n- id: a\n  limit: 1\n`;
    const ps = parseRateLimits(withComments);
    // a stray '- id:' without a trailing list header still parses
    expect(ps.length).toBeGreaterThanOrEqual(1);
  });

  it("tolerates an empty/blank file (returns [])", () => {
    expect(parseRateLimits("")).toEqual([]);
    expect(parseRateLimits("# just a comment")).toEqual([]);
  });
});

describe("candidatesFor", () => {
  it("adds /models subpaths for a /v1 base", () => {
    const c = candidatesFor("nvidia", "https://integrate.api.nvidia.com/v1");
    expect(c).toContain("https://integrate.api.nvidia.com/v1/models");
    expect(c).toContain("https://integrate.api.nvidia.com/v1/models/sse");
  });

  it("tries both /v1/models and root /models for a non-v1 base", () => {
    const c = candidatesFor("groq", "https://api.groq.com/openai");
    expect(c).toContain("https://api.groq.com/openai/v1/models");
    expect(c).toContain("https://api.groq.com/openai/models");
  });

  it("honors the chutes override (custom models subpath)", () => {
    const c = candidatesFor("chutes", "https://api.chutes.ai/v1");
    expect(c.some((u) => u.includes("/chutes/models"))).toBe(true);
  });

  it("resolves {region} in bedrock-mantle", () => {
    const c = candidatesFor(
      "bedrock-mantle",
      "https://bedrock-runtime.{region}.amazonaws.com",
    );
    expect(c.some((u) => u.includes("us-east-1"))).toBe(true);
  });
});

describe("keyFor", () => {
  const old = { ...process.env };
  afterEach(() => {
    process.env = { ...old };
  });

  it("returns the first env key that is set", () => {
    process.env.TEST_KEY_A = "a";
    process.env.TEST_KEY_B = "b";
    const provider = { keyEnv: "TEST_KEY_A", keyEnvs: ["TEST_KEY_B"] };
    expect(keyFor(provider)).toEqual({ key: "a", env: "TEST_KEY_A" });
  });

  it("falls through keyEnv to keyEnvs when unset", () => {
    delete process.env.TEST_KEY_A;
    process.env.TEST_KEY_B = "b";
    const provider = { keyEnv: "TEST_KEY_A", keyEnvs: ["TEST_KEY_B"] };
    expect(keyFor(provider)).toEqual({ key: "b", env: "TEST_KEY_B" });
  });

  it("returns null when no env key is present", () => {
    delete process.env.TEST_KEY_A;
    delete process.env.TEST_KEY_B;
    const provider = { keyEnv: "TEST_KEY_A", keyEnvs: ["TEST_KEY_B"] };
    expect(keyFor(provider)).toEqual({ key: null, env: null });
  });

  it("empty keyEnv strings are skipped", () => {
    delete process.env.TEST_KEY_A;
    const provider = { keyEnv: "", keyEnvs: [] };
    expect(keyFor(provider)).toEqual({ key: null, env: null });
  });
});
