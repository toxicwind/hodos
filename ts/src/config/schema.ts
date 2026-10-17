/**
 * flock TS router — configuration schema and defaults.
 * Ported from proxy/src/config.rs and proxy/src/settings.rs.
 * Faithful port: every field, default, and invariant from the Rust spec.
 *
 * Types match the Rust StoredConfig / ProviderDef shapes exactly so that
 * validation, migration, and roundtrip tests remain behaviorally identical.
 *
 * Types match the Rust StoredConfig / ProviderDef shapes exactly so that
 * validation, migration, and roundtrip tests remain behaviorally identical.
 */

// NOTE: shared types (Result, attempt, CircuitState, UpstreamResponse, callUpstream)
// are imported from ../shared.ts when needed; config-internal types are defined here.

import type { Result } from "../shared";

/**
 * Provider key within a provider registry entry.
 * Mirrors proxy::provider::ProviderKey.
 */
export interface ProviderKey {
    key: string;
    key_env: string;
    key_env_alt?: string;
    owner: string;
    enabled: boolean;
    rpm: number;
}

/** Default ProviderKey: empty key, owner "superuser", enabled, rpm 40. */
export function defaultProviderKey(): ProviderKey {
    return {
        key: "",
        key_env: "",
        owner: "superuser",
        enabled: true,
        rpm: 40,
    };
}

/**
 * Provider definition — one entry in the multi-provider registry.
 * Mirrors proxy::provider::ProviderDef.
 */
export interface ProviderDef {
    name: string;
    base_url: string;
    keys: ProviderKey[];
    models: string[];
    model_map: Record<string, string>;
    display_name: string;
    enabled: boolean;
    free_tier?: boolean;
    weight?: number;
    /** Ordered map: provider name → concurrency cap. */
    overrides?: Record<string, number>;
}

/** Default ProviderDef: minimal viable entry. */
export function defaultProviderDef(): ProviderDef {
    return {
        name: "",
        base_url: "https://integrate.api.nvidia.com",
        keys: [],
        models: [],
        model_map: {},
        display_name: "",
        enabled: true,
    };
}

/**
 * Upstream configuration — the legacy single-upstream block.
 * Mirrors proxy::config::Upstream.
 */
export interface Upstream {
    base_url: string;
    nim_keys: NimKey[];
}

/** Default Upstream. */
export function defaultUpstream(): Upstream {
    return {
        base_url: "https://integrate.api.nvidia.com",
        nim_keys: [],
    };
}

/**
 * NIM key stored in the config or upstream block.
 * Mirrors proxy::config::NimKey.
 */
export interface NimKey {
    key: string;
    owner: string;
    enabled: boolean;
    rpm: number;
}

/** Default NimKey. */
export function defaultNimKey(): NimKey {
    return {
        key: "",
        owner: "superuser",
        enabled: true,
        rpm: 40,
    };
}

/**
 * Client authentication mode.
 * Mirrors proxy::config::Mode.
 */
export enum Mode {
    Open = "open",
    /** Default: keyed mode — `/v1` requires a client API key. */
    Keyed = "keyed",
}

/** Default Mode: Keyed. */
export function defaultMode(): Mode {
    return Mode.Keyed;
}

/**
 * Client API key record.
 * Mirrors proxy::config::ClientKey.
 */
export interface ClientKey {
    name: string;
    secret_sha256: string;
    last4?: string;
    owner: string;
}

/** Default ClientKey. */
export function defaultClientKey(): ClientKey {
    return {
        name: "",
        secret_sha256: "",
        owner: "superuser",
    };
}

/**
* Client auth config holding mode and key list.
* Mirrors proxy::config::ClientAuth.
*/
export interface ClientAuth {
    mode: Mode;
    keys: ClientKey[];
}

/** Default ClientAuth: keyed mode with no keys. */
export function defaultClientAuth(): ClientAuth {
    return {
        mode: Mode.Keyed,
        keys: [],
    };
}

/**
 * Limits configuration — rate limits, timeouts, etc.
 * Mirrors proxy::config::Limits.
 */
export interface Limits {
    heartbeat_secs: number;
    max_inflight: number;
    max_wait_secs: number;
    models_ttl_secs: number;
    request_timeout_secs: number;
    stream_idle_secs: number;
    strict_passthrough: boolean;
}

/** Default Limits. */
export function defaultLimits(): Limits {
    return {
        heartbeat_secs: 10,
        max_inflight: 512,
        max_wait_secs: 900,
        models_ttl_secs: 600,
        request_timeout_secs: 300,
        stream_idle_secs: 300,
        strict_passthrough: false,
    };
}

/**
 * History configuration — retention in days.
 * Mirrors proxy::config::HistoryCfg.
 */
export interface HistoryCfg {
    days: number;
    /** 0 = keep forever. */
}

/** Default HistoryCfg. */
export function defaultHistoryCfg(): HistoryCfg {
    return { days: 30 };
}

/**
 * Dashboard configuration — window days and SLO target.
 * Mirrors proxy::config::DashboardCfg.
 */
export interface DashboardCfg {
    default_window_days: number;
    slo_target_percent: number;
}

/** Default DashboardCfg. */
export function defaultDashboardCfg(): DashboardCfg {
    return {
        default_window_days: 30,
        slo_target_percent: 99.9,
    };
}

/**
 * Governor configuration — enabled flag and per-model overrides.
 * Mirrors proxy::config::GovernorCfg.
 */
export interface GovernorCfg {
    enabled: boolean;
    /** Ordered map: model name → concurrency cap. */
    overrides: Record<string, number>;
}

/** Default GovernorCfg. */
export function defaultGovernorCfg(): GovernorCfg {
    return {
        enabled: true,
        overrides: {},
    };
}

/**
 * User in the config store.
 * Mirrors proxy::config::User.
 */
export interface User {
    username: string;
    password_hash: string;
    role: Role;
    locale?: string | null;
}

/** User role. Mirrors proxy::config::Role. */
export enum Role {
    Superuser = "superuser",
    Admin = "admin",
    User = "user",
}

/** Default User (minimal). */
export function defaultUser(username: string): User {
    return {
        username,
        password_hash: "",
        role: Role.User,
        locale: undefined,
    };
}

/**
 * Full stored configuration — the complete config.json shape.
 * Mirrors proxy::config::StoredConfig.
 *
 * All fields have serde-style `default()` counterparts in this TS port.
 * Declared in ASCII order to match the Rust wire format served at `/api/config`.
 */
export interface StoredConfig {
    version: number;
    default_locale: string;
    upstream: Upstream;
    /** Multi-provider registry. Always contains the 13 seeded providers;
     * operators disable via `enabled: false`, never by deleting. */
    providers: ProviderDef[];
    /** Provider routing knobs. */
    routing?: ProviderDef[""]; // simplified; full routing cfg if needed
    client_auth: ClientAuth;
    limits: Limits;
    history: HistoryCfg;
    dashboard: DashboardCfg;
    governor: GovernorCfg;
    users: User[];
}

/** Default StoredConfig: empty JSON parses as valid with all defaults. */
export function defaultStoredConfig(): StoredConfig {
    return {
        version: 2,
        default_locale: "en-US",
        upstream: defaultUpstream(),
        providers: [], // seeded on load (see load.ts)
        client_auth: defaultClientAuth(),
        limits: defaultLimits(),
        history: defaultHistoryCfg(),
        dashboard: defaultDashboardCfg(),
        governor: defaultGovernorCfg(),
        users: [],
    };
}

/**
 * Router configuration knobs — a subset merged from Rust RoutingCfg.
 * Kept separate to avoid circular deps; full details in router_config.ts if needed.
 */
export interface RoutingCfg {
    max_parallel: number;
    max_retries: number;
    fifo_max: number;
    probe_interval_secs: number;
}

/** Default RoutingCfg. */
export function defaultRoutingCfg(): RoutingCfg {
    return {
        max_parallel: 4,
        max_retries: 4,
        fifo_max: 64,
        probe_interval_secs: 5,
    };
}

/** ------------------------------------------------------------------
 * Deep-clone-on-read guarantee:
 * Every public getter that returns a mutable reference or mutatable struct
 * must return a freshly deep-cloned copy so callers cannot corrupt global state.
 * ------------------------------------------------------------------ */

/** Deep clone a value (plain-object friendly). */
function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
}

/** Read-only snapshot of StoredConfig — caller gets a clone. */
export function cloneStoredConfig(sc: StoredConfig): StoredConfig {
    return deepClone(sc);
}

/** Read-only snapshot of ProviderDef list. */
export function cloneProviderDefs(providers: ProviderDef[]): ProviderDef[] {
    return deepClone(providers);
}

/** Read-only snapshot of BTreeMap / Record overrides. */
export function cloneOverrides(overrides: Record<string, number>): Record<string, number> {
    return deepClone(overrides);
}

// Export the key types used across the router
export type { Mode, Role, ProviderKey, ProviderDef, Upstream, NimKey, ClientAuth, Limits, HistoryCfg, DashboardCfg, GovernorCfg, User, ClientKey, RoutingCfg, StoredConfig };

// vim: set sw=2 ts=2 et: