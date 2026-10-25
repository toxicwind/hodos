/**
 * probe-catalogs.ts — rhodochrosite native catalog prober.
 *
 * Merges the estate's provider catalogs into ONE live-probed model/limit map:
 *   1. pinax providers            (ranch/pinax/generated/providers.json) — where providers live
 *   2. api-evangelist/nvidia-nim  (submodule reference/nvidia-nim)       — NIM API surfaces + policies
 *   3. api-evangelist/nvidia      (submodule reference/nvidia)           — broader NVIDIA limits/llms
 *
 * It then probes each provider's models endpoint to LIVE truth (verdicts:
 * ok / needs-auth / throttled / missing / unreachable) and merges the
 * submodule rate-limits so rhodochrosite paces against the ACTUAL upstream policy
 * (e.g. NVIDIA hosted NIM = 40 RPM / 5 concurrent), not a guess.
 *
 * The output (catalog.json) is the single source the control plane and rhodochrosite
 * routing read — merging the legacy prober + the two api-evangelist catalogs,
 * both vendored as submodules under reference/.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REF = join(here, "..", "reference");

// ---- sources (configurable for tests) -------------------------------------
const PINAX_PROVIDERS =
  process.env.PINAX_PROVIDERS_JSON ??
  "/home/toxic/estate/ranch/pinax/generated/providers.json";
const NIM_RATE_LIMITS =
  process.env.NIM_RATE_LIMITS_YML ??
  join(REF, "nvidia-nim", "rate-limits", "nvidia-nim-rate-limits.yml");
const NVIDIA_RATE_LIMITS =
  process.env.NVIDIA_RATE_LIMITS_YML ??
  join(REF, "nvidia", "rate-limits", "nvidia-rate-limits.yml");
const OUT = process.env.PROBE_OUT ?? here;
const PROBE_TIMEOUT_MS = 8000;
const CONCURRENCY = 12;

export type EndpointVerdict =
  "ok" | "needs-auth" | "throttled" | "missing" | "unreachable";

export interface RatePolicy {
  id: string;
  name: string;
  scope?: string;
  surface?: string;
  metric?: string;
  limit?: number | string;
  window?: string;
  description?: string;
  /** provenance from the vendored file: how + when it was produced. */
  method?: string;
  generated?: string;
  /**
   * True when the vendored file is `method: generated` and NOT a dated,
   * verbatim transcription from the provider — an unverified snapshot
   * (api-evangelist rate-limits are May-2026 `generated` stubs). Live 429
   * `Retry-After` headers are the AUTHORITATIVE signal; these are advisory
   * pace hints and must never override a real 429.
   */
  advisory?: boolean;
}

export interface ProviderEndpoint {
  name: string;
  baseUrl: string;
  endpoint: string | null;
  status: number | null;
  verdict: EndpointVerdict;
  models: number;
  keyEnv: string | null;
  /** merged upstream rate policies from the vendored catalogs */
  rates: RatePolicy[];
}

/**
 * A SyntheticCheck — the canonical monitoring artifact shape defined by the
 * api-evangelist/monitoring submodule (reference/monitoring/json-schema/
 * monitoring-synthetic-check-schema.json). The prober emits one per provider
 * so the catalog is consumable by any monitoring/observability pipeline.
 */
export interface SyntheticCheck {
  id: string;
  name: string;
  description: string;
  type: "endpoint-probe" | "models-listing";
  target_url: string | null;
  request: { method: "GET"; url: string | null; auth?: string };
  assertions: Array<{
    property: string;
    op: string;
    expected: unknown;
    actual: unknown;
  }>;
  locations: string[];
  frequency_seconds: number;
  status: string;
  tags: string[];
  created: string;
}

export function toSyntheticCheck(r: ProviderEndpoint): SyntheticCheck {
  const ok = r.verdict === "ok";
  return {
    id: `rhodochrosite-${r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: `${r.name} models endpoint`,
    description: `Live probe of ${r.name} ${r.endpoint ?? r.baseUrl ?? "(no baseUrl)"}`,
    type: "endpoint-probe",
    target_url: r.endpoint,
    request: {
      method: "GET",
      url: r.endpoint,
      ...(r.keyEnv ? { auth: r.keyEnv } : {}),
    },
    assertions: [
      {
        property: "status",
        op: ok ? "==" : "!=",
        expected: 200,
        actual: r.status,
      },
      { property: "models", op: ">=", expected: 1, actual: r.models },
    ],
    locations: ["estate"],
    frequency_seconds: 3600,
    status: r.verdict === "ok" ? "pass" : r.verdict,
    tags: ["provider", "models", r.verdict],
    created: new Date().toISOString(),
  };
}

const PATH_OVERRIDES: Record<string, (base: string) => string[]> = {
  chutes: (base) => [
    `${base.replace(/\/+$/, "")}/chutes/models`,
    `${base.replace(/\/+$/, "")}/chutes/models/sse`,
  ],
  "bedrock-mantle": (base) => {
    const resolved = base.replace("{region}", "us-east-1");
    return [
      `${resolved.replace(/\/+$/, "")}/models/sse`,
      `${resolved.replace(/\/+$/, "")}/models`,
    ];
  },
  qianfan: (base) => [
    `${base.replace(/\/+$/, "")}/models`,
    `${base.replace(/\/+$/, "")}/models/sse`,
  ],
};

/** Parse an API Commons rate-limits yml into RatePolicy[] (no yaml dep). */
export function parseRateLimits(raw: string): RatePolicy[] {
  const lines = raw.split("\n");
  const out: RatePolicy[] = [];
  let cur: Partial<RatePolicy> | null = null;
  const isKey = (l: string) => /^-?\s*(\w[\w-]*):\s*/.test(l);
  for (const rawLine of lines) {
    const line = rawLine.replace(/^#.*/, "");
    if (!line.trim()) continue;
    if (/^-\s*id:\s*/.test(line)) {
      if (cur && cur.id) out.push(cur as RatePolicy);
      cur = {};
      cur.id = line.replace(/^-\s*id:\s*/, "").trim();
    } else if (isKey(line) && cur) {
      const m = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
      if (m) {
        const val = m[2].replace(/^['"]|['"]$/g, "").trim();
        if (m[1] === "id") cur.id = cur.id ?? val;
        else if (
          [
            "name",
            "scope",
            "surface",
            "metric",
            "window",
            "description",
          ].includes(m[1])
        )
          (cur as Record<string, unknown>)[m[1]] = val;
        else if (m[1] === "limit")
          cur.limit = /^\d+$/.test(val) ? Number(val) : val;
      }
    }
  }
  if (cur && cur.id) out.push(cur as RatePolicy);
  return out;
}

export function candidatesFor(name: string, baseUrl: string): string[] {
  const override = PATH_OVERRIDES[name];
  if (override) return override(baseUrl);
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1")) {
    return [
      `${base}/models/sse`,
      `${base}/models`,
      `${base.replace(/\/v1$/, "")}/models`,
    ];
  }
  return [
    `${base}/v1/models/sse`,
    `${base}/v1/models`,
    `${base}/models/sse`,
    `${base}/models`,
  ];
}

export function keyFor(provider: Record<string, unknown>): {
  key: string | null;
  env: string | null;
} {
  const names = [
    provider.keyEnv as string | undefined,
    ...((provider.keyEnvs as string[] | undefined) ?? []),
  ].filter((n): n is string => typeof n === "string" && n.length > 0);
  for (const env of names) {
    const value = process.env[env];
    if (value) return { key: value, env };
  }
  return { key: null, env: null };
}

async function fetchModels(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; models: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    if (res.status !== 200) return { status: res.status, models: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: res.status, models: [] };
    }
    const items =
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { data?: unknown }).data)
        ? (parsed as { data: unknown[] }).data
        : Array.isArray(parsed)
          ? parsed
          : [];
    const models = items
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          const id = rec.id ?? rec.name ?? rec.model;
          return typeof id === "string" ? id : null;
        }
        return null;
      })
      .filter((id): id is string => !!id);
    return { status: res.status, models };
  } catch {
    return { status: 0, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function probeProvider(
  provider: Record<string, unknown>,
  rates: RatePolicy[],
): Promise<ProviderEndpoint> {
  const name = (provider.name as string) ?? "unknown";
  const baseUrl = (provider.baseUrl as string) ?? "";
  const { key, env } = keyFor(provider);
  const attempts: Array<{ url: string; status: number }> = [];

  if (!baseUrl) {
    return {
      name,
      baseUrl,
      endpoint: null,
      status: null,
      verdict: "missing",
      models: 0,
      keyEnv: env,
      rates,
    };
  }

  for (const url of candidatesFor(name, baseUrl)) {
    const headerSets: Array<Record<string, string>> = [];
    if (key) {
      headerSets.push({ Authorization: `Bearer ${key}` });
      if (name.includes("chutes")) headerSets.push({ "Chutes-Auth": key });
    }
    headerSets.push({});
    for (const headers of headerSets) {
      const { status, models } = await fetchModels(url, headers);
      attempts.push({ url, status });
      if (status === 200 && models.length > 0) {
        return {
          name,
          baseUrl,
          endpoint: url,
          status,
          verdict: "ok",
          models: models.length,
          keyEnv: env,
          rates,
        };
      }
      if (status === 401 || status === 403) break;
    }
  }

  const best = attempts.reduce<{ url: string; status: number } | null>(
    (acc, attempt) => {
      const score = (s: number) =>
        s === 429
          ? 5
          : s === 401 || s === 403
            ? 4
            : s === 404
              ? 2
              : s === 0
                ? 1
                : 3;
      if (!acc) return attempt;
      return score(attempt.status) > score(acc.status) ? attempt : acc;
    },
    null,
  );
  const status = best?.status ?? null;
  const verdict: EndpointVerdict =
    status === null
      ? "unreachable"
      : status === 429
        ? "throttled"
        : status === 401 || status === 403
          ? "needs-auth"
          : "missing";
  return {
    name,
    baseUrl,
    endpoint: best?.url ?? null,
    status,
    verdict,
    models: 0,
    keyEnv: env,
    rates,
  };
}

export async function buildCatalog(): Promise<{
  generatedAt: string;
  sources: string[];
  providers: ProviderEndpoint[];
  checks: SyntheticCheck[];
  rates: { source: string; policies: RatePolicy[] }[];
  summary: Record<string, number>;
}> {
  // 1. pinax providers
  let providers: Array<Record<string, unknown>> = [];
  try {
    const raw = JSON.parse(readFileSync(PINAX_PROVIDERS, "utf8")) as {
      providers?: Array<Record<string, unknown>>;
    };
    providers = Array.isArray(raw.providers) ? raw.providers : [];
  } catch {
    providers = [];
  }

  // 2. merged rate policies from both api-evangelist catalogs
  const rateSources: { source: string; policies: RatePolicy[] }[] = [];
  for (const [label, path] of [
    ["nvidia-nim", NIM_RATE_LIMITS],
    ["nvidia", NVIDIA_RATE_LIMITS],
  ] as const) {
    try {
      rateSources.push({
        source: label,
        policies: parseRateLimits(readFileSync(path, "utf8")),
      });
    } catch {
      rateSources.push({ source: label, policies: [] });
    }
  }
  const allRates = rateSources.flatMap((s) => s.policies);

  const results: ProviderEndpoint[] = [];
  const queue = [...providers];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      results.push(await probeProvider(next, allRates));
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.name.localeCompare(b.name));

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.verdict === "ok").length,
    needsAuth: results.filter((r) => r.verdict === "needs-auth").length,
    throttled: results.filter((r) => r.verdict === "throttled").length,
    missing: results.filter((r) => r.verdict === "missing").length,
    unreachable: results.filter((r) => r.verdict === "unreachable").length,
    ratePolicies: allRates.length,
  };

  return {
    generatedAt: new Date().toISOString(),
    sources: [PINAX_PROVIDERS, NIM_RATE_LIMITS, NVIDIA_RATE_LIMITS],
    providers: results,
    checks: results.map(toSyntheticCheck),
    rates: rateSources,
    summary,
  };
}

export async function main(): Promise<void> {
  const artifact = await buildCatalog();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "catalog.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(artifact.summary, null, 2));
  for (const r of artifact.providers) {
    console.log(
      `${r.verdict.padEnd(12)} ${r.name.padEnd(20)} ${String(r.status ?? "-").padStart(4)} models=${String(r.models).padStart(4)} ${r.endpoint ?? ""}`,
    );
  }
}

if (import.meta.main) {
  await main();
}
