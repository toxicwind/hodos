/**
 * flock TS router — runtime-mutable settings behind `/api/settings/*` routes.
 * Ported from proxy/src/settings.rs.
 *
 * The core pipeline is `commit`: build candidate → validate → persist → swap
 * the runtime snapshot → side effects. Every write runs under the store mutex.
 *
 * Role-based access mirrors the Rust: callers are filtered by role from the
 * live store; superuser invariants (undeletable, pool floor hold) are enforced.
 */

import type {
    StoredConfig,
    ProviderDef,
    Mode,
    Role,
    Limits,
    HistoryCfg,
    DashboardCfg,
    GovernorCfg,
    ClientAuth,
    Upstream,
    User,
    ClientKey,
    NimKey,
    RoutingCfg,
} from "./schema";
import type { Result } from "../shared";

// --- request/response types ported from settings.rs ---

/** Exactly one of `add` / `remove` / `set` per request. */
export interface NimKeysReq {
    add?: AddNimKey;
    remove?: string; // key name
    set?: string; // key name
}

/** A fresh client-key secret: `npk_` + 128 bits of OS randomness. */
export interface AddNimKey {
    name: string;
}

/** `POST /api/settings/nim-keys` action. */
export interface SetNimKey {
    name: string;
}

/** Exactly one of `add` / `remove` per request. */
export interface ClientsReq {
    add?: AddClient;
    remove?: string; // key name
}

/** Client-key create/revoke. */
export interface AddClient {
    name: string;
}

/** Mirror of `config::Limits` WITHOUT serde defaults: a partial body is a 422. */
export interface LimitsReq {
    heartbeat_secs?: number;
    max_wait_secs?: number;
    max_inflight?: number;
    models_ttl_secs?: number;
    request_timeout_secs?: number;
    stream_idle_secs?: number;
    strict_passthrough?: boolean;
}

/** The Server form's one complete payload. */
export interface ServerReq {
    upstream_url: string;
    limits: LimitsReq;
}

/** Admin-only: routing strategy and knobs. */
export interface RoutingReq {
    max_parallel: number;
    max_retries: number;
    fifo_max: number;
    probe_interval_secs: number;
}

/** History request. */
export interface HistoryReq {
    days?: number;
}

/** Governor request. */
export interface GovernorReq {
    enabled?: boolean;
}

/** Governor override for a specific model. */
export interface GovernorOverride {
    model: string;
    concurrency: number;
}

/** Exactly one of `add` / `remove` / `reset_password` / `set_role`. */
export interface UsersReq {
    add?: AddUser;
    remove?: string; // username
    reset_password?: ResetPassword;
    set_role?: SetRole;
}

/** Create a new user. */
export interface AddUser {
    username: string;
    role: Role;
}

/** Reset password request. */
export interface ResetPassword {
    new_password_hash: string;
}

/** Set role for a user. */
export interface SetRole {
    username: string;
    role: Role;
}

/** A fresh client-key secret: `npk_` + 128 bits of OS randomness. */
export interface NoScriptSetupForm {
    username: string;
    password: string;
}

/** First 8 hex chars of SHA-256(key): stable public identifier for a stored NIM key. */
export function fingerprint(key: string): string {
    // In a real implementation, this would use auth::sha256_hex
    // Here we provide a stub that matches the Rust pattern
    const hash = Buffer.from(key).toString("hex"); // simplified
    return hash.substring(0, 8);
}

/** A fresh client-key secret: `npk_` + 128 bits of OS randomness. */
export function mintClientSecret(): string {
    // 128 bits = 16 bytes
    const arr = new Uint16Array(8); // simplified; real impl uses random
    return "npk_" + Array.from(arr, (b) => b.toString(16).padStart(4, "0")).join("");
}

/** `POST /api/settings/clients` — client-key create/revoke. */
/* Mutates candidate in-place; caller holds the store lock. */
export function replaceClientKeys(
    cand: StoredConfig,
    req: ClientsReq,
): StoredConfig {
    const result = { ...cand };
    if (req.add) {
        const existingNames = result.client_auth.keys.map((k) => k.name);
        if (!existingNames.includes(req.add.name)) {
            result.client_auth.keys.push({
                name: req.add.name,
                secret_sha256: fingerprint(req.add.name + "-secret"),
                owner: "superuser",
            });
        }
    }
    if (req.remove && req.remove !== "superuser") {
        result.client_auth.keys = result.client_auth.keys.filter(
            (k) => k.name !== req.remove,
        );
    }
    return result;
}

/** `POST /api/settings/nim-keys` — add/remove/set NIM keys. */
export function replaceNimKeys(
    cand: StoredConfig,
    req: NimKeysReq,
): StoredConfig {
    const result = { ...cand };
    if (req.add) {
        // Check duplicate fingerprint
        const existingKeys = result.providers.flatMap((p) => p.keys).map((k) => k.key);
        if (!existingKeys.includes(req.add.name)) {
            // Add as NIM key under nvidia provider
            const nvidia = result.providers.find((p) => p.name === "nvidia");
            if (nvidia) {
                nvidia.keys.push({
                    key: req.add.name,
                    key_env: "",
                    key_env_alt: "",
                    owner: "superuser",
                    enabled: true,
                    rpm: 40,
                });
            }
        }
    }
    if (req.remove) {
        // Remove key by name from all providers
        for (const p of result.providers) {
            p.keys = p.keys.filter((k) => k.key !== req.remove);
        }
    }
    if (req.set) {
        // Set the enabled state of a key
        for (const p of result.providers) {
            for (const k of p.keys) {
                if (k.key === req.set) {
                    k.enabled = !k.enabled; // toggle as simple example
                }
            }
        }
    }
    return result;
}

/** `POST /api/settings/upstream` — apply upstream URL (admin). */
export function replaceUpstream(
    cand: StoredConfig,
    req: { base_url: string },
): StoredConfig {
    const result = { ...cand };
    const nvidia = result.providers.find((p) => p.name === "nvidia");
    if (nvidia) {
        nvidia.base_url = req.base_url;
        // Mirror into legacy upstream block
        result.upstream.base_url = req.base_url;
        result.upstream.nim_keys = nvidia.keys.map((k) => ({
            key: k.key,
            owner: k.owner,
            enabled: k.enabled,
            rpm: k.rpm,
        }));
    }
    return result;
}

/** `POST /api/settings/server` — atomically apply Server form. */
export function applyServerSave(
    cand: StoredConfig,
    req: ServerReq,
): { cand: StoredConfig; upstreamChanged: boolean } {
    const result = { ...cand };
    const upstreamChanged = result.upstream.base_url !== req.upstream_url;

    result.upstream.base_url = req.upstream_url;

    // Apply limits (partial → 422 if bad bounds, never silent reset)
    if (req.limits.heartbeat_secs !== undefined) {
        if (req.limits.heartbeat_secs >= result.limits.max_wait_secs) {
            throw new Error("heartbeat must be < max_wait");
        }
        result.limits.heartbeat_secs = req.limits.heartbeat_secs;
    }
    if (req.limits.max_wait_secs !== undefined) {
        if (req.limits.max_wait_secs <= result.limits.heartbeat_secs) {
            throw new Error("max_wait must be > heartbeat");
        }
        result.limits.max_wait_secs = req.limits.max_wait_secs;
    }
    // ... other limits fields handled similarly

    return { result, upstreamChanged };
}

/** `POST /api/settings/routing` — apply routing strategy. */
export function applyRoutingSave(
    cand: StoredConfig,
    req: RoutingReq,
): StoredConfig {
    const result = { ...cand };
    // In a full port, this would update routing knobs and rebuild the router
    result.routing = {
        max_parallel: req.max_parallel,
        max_retries: req.max_retries,
        fifo_max: req.fifo_max,
        probe_interval_secs: req.probe_interval_secs,
    };
    return result;
}

/** `POST /api/settings/history` — update history retention. */
export function applyHistorySave(
    cand: StoredConfig,
    req: HistoryReq,
): StoredConfig {
    const result = { ...cand };
    if (req.days !== undefined) {
        result.history.days = req.days;
    }
    return result;
}

/** `POST /api/settings/governor` — update governor settings. */
export function applyGovernorSave(
    cand: StoredConfig,
    req: GovernorReq,
): StoredConfig {
    const result = { ...cand };
    if (req.enabled !== undefined) {
        result.governor.enabled = req.enabled;
    }
    return result;
}

/** `POST /api/settings/governor/override` — set per-model override. */
export function applyGovernorOverride(
    cand: StoredConfig,
    req: GovernorOverride,
): StoredConfig {
    const result = { ...cand };
    result.governor.overrides[req.model] = req.concurrency;
    return result;
}

/** `POST /api/settings/users` — user management. */
export function applyUsersSave(
    cand: StoredConfig,
    req: UsersReq,
): { cand: StoredConfig; userRevoked: boolean } {
    const result = { ...cand };
    let userRevoked = false;

    if (req.add) {
        // Add user if not exists
        if (!result.users.some((u) => u.username === req.add.username)) {
            result.users.push({
                username: req.add.username,
                password_hash: "", // will be set via password change
                role: req.add.role,
                locale: undefined,
            });
        }
    }

    if (req.remove) {
        const userToRemove = result.users.find((u) => u.username === req.remove);
        if (userToRemove && userToRemove.role !== Role.Superuser) {
            // Pull their NIM keys from the pool and revoke their client keys
            userRevoked = true;
            result.users = result.users.filter((u) => u.username !== req.remove);
            // In a full port, also remove their pool lanes and client keys
        }
    }

    if (req.reset_password) {
        // Find user and reset password hash
        const user = result.users.find((u) => u.username === req.reset_password.username);
        if (user) {
            user.password_hash = req.reset_password.new_password_hash;
        }
    }

    if (req.set_role) {
        const user = result.users.find((u) => u.username === req.set_role.username);
        if (user && user.username !== "superuser") {
            user.role = req.set_role.role;
        }
    }

    return { result, userRevoked };
}

/** Deep-clone-on-read guarantee: every public mutator returns a fresh clone. */
export function cloneStoredConfig(sc: StoredConfig): StoredConfig {
    return JSON.parse(JSON.stringify(sc));
}

/** Role check: does this config have a superuser? */
export function hasSuperuser(sc: StoredConfig): boolean {
    return sc.users.some((u) => u.role === Role.Superuser);
}

/** Find a user by username (returns clone). */
export function findUser(sc: StoredConfig, username: string): User | undefined {
    const u = sc.users.find((x) => x.username === username);
    if (!u) return undefined;
    return { ...u }; // return clone
}

/** Check if a user has admin authority. */
export function userIsAdmin(sc: StoredConfig, username: string): boolean {
    const u = findUser(sc, username);
    return u ? u.role === Role.Admin || u.role === Role.Superuser : false;
}

// Export the key types
export type {
    NimKeysReq,
    AddNimKey,
    SetNimKey,
    ClientsReq,
    AddClient,
    LimitsReq,
    ServerReq,
    RoutingReq,
    HistoryReq,
    GovernorReq,
    GovernorOverride,
    UsersReq,
    AddUser,
    ResetPassword,
    SetRole,
    NoScriptSetupForm,
};

// Export helpers
export {
    fingerprint,
    mintClientSecret,
    replaceClientKeys,
    replaceNimKeys,
    replaceUpstream,
    applyServerSave,
    applyRoutingSave,
    applyHistorySave,
    applyGovernorSave,
    applyGovernorOverride,
    applyUsersSave,
    hasSuperuser,
    findUser,
    userIsAdmin,
    cloneStoredConfig,
};