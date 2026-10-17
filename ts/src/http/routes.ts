/** Route descriptor — port of `RouteContract` from `routes.rs`. */
export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "ANY";

/** Access levels mirroring `routes.rs` Access enum. */
export type RouteAccess = "Public" | "OperatorAny" | "OperatorAdmin" | "Client";

/** Phases mirroring `routes.rs` Phase enum. */
export type RoutePhase = "PreSetup" | "PostSetup" | "Always";

/** Route descriptor — each entry from the Rust ROUTES constant. */
export interface RouteDescriptor {
	method: RouteMethod;
	path: string;
	access: RouteAccess;
	phase: RoutePhase;
	openapi: boolean;
	probe_path: string;
}

/** Route table — flat array of route descriptors, ported from `routes.rs` ROUTES constant.
 *  The parity test asserts this set of (method, path) pairs is identical to the Rust one. */
export const ROUTES: RouteDescriptor[] = [
	/* Static assets (public) */
	{ method: "GET", path: "/assets/public/public.css",  access: "Public",    phase: "Always",    openapi: false, probe_path: "/assets/public/public.css" },
	{ method: "GET", path: "/assets/public/noscript.css", access: "Public",    phase: "Always",    openapi: false, probe_path: "/assets/public/noscript.css" },
	{ method: "GET", path: "/assets/public/setup.js",   access: "Public",    phase: "Always",    openapi: false, probe_path: "/assets/public/setup.js" },
	{ method: "GET", path: "/assets/public/login.js",   access: "Public",    phase: "Always",    openapi: false, probe_path: "/assets/public/login.js" },
	{ method: "GET", path: "/assets/public/locales/{locale}.json", access: "Public", phase: "Always", openapi: false, probe_path: "/assets/public/locales/en-US.json" },

	/* Static assets (operator) */
	{ method: "GET", path: "/assets/operator/operator.css",  access: "OperatorAny", phase: "PostSetup", openapi: false, probe_path: "/assets/operator/operator.css" },
	{ method: "GET", path: "/assets/operator/shared.js",      access: "OperatorAny", phase: "PostSetup", openapi: false, probe_path: "/assets/operator/shared.js" },
	{ method: "GET", path: "/assets/operator/dashboard.js",   access: "OperatorAny", phase: "PostSetup", openapi: false, probe_path: "/assets/operator/dashboard.js" },
	{ method: "GET", path: "/assets/operator/settings.js",    access: "OperatorAny", phase: "PostSetup", openapi: false, probe_path: "/assets/operator/settings.js" },
	{ method: "GET", path: "/assets/operator/locales/{locale}.json", access: "OperatorAny", phase: "PostSetup", openapi: false, probe_path: "/assets/operator/locales/en-US.json" },

	/* Root and dashboard */
	{ method: "GET", path: "/",               access: "OperatorAny", phase: "PostSetup", openapi: false, probe_path: "/" },
	{ method: "GET", path: "/dash",           access: "OperatorAny", phase: "PostSetup", openapi: false, probe_path: "/dash" },
	{ method: "GET", path: "/metrics",          access: "OperatorAny", phase: "PostSetup", openapi: false, probe_path: "/metrics" },

	/* API routes (dashboard) */
	{ method: "GET", path: "/api/dashboard",    access: "OperatorAny", phase: "PostSetup", openapi: true,  probe_path: "/api/dashboard" },
	{ method: "GET", path: "/api/dashboard/now", access: "OperatorAny", phase: "PostSetup", openapi: true,  probe_path: "/api/dashboard/now" },
	{ method: "GET", path: "/api/config",       access: "OperatorAny", phase: "PostSetup", openapi: true,  probe_path: "/api/config" },
	{ method: "GET", path: "/api/locale-bootstrap", access: "Public", phase: "Always", openapi: true,  probe_path: "/api/locale-bootstrap" },

	/* API settings routes */
	{ method: "POST", path: "/api/settings/nim-keys",    access: "OperatorAny", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/nim-keys" },
	{ method: "POST", path: "/api/settings/clients",     access: "OperatorAny", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/clients" },
	{ method: "POST", path: "/api/settings/limits",      access: "OperatorAdmin", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/limits" },
	{ method: "POST", path: "/api/settings/server",      access: "OperatorAdmin", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/server" },
	{ method: "POST", path: "/api/settings/history",     access: "OperatorAdmin", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/history" },
	{ method: "POST", path: "/api/settings/governor",    access: "OperatorAdmin", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/governor" },
	{ method: "POST", path: "/api/settings/users",       access: "OperatorAdmin", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/users" },
	{ method: "POST", path: "/api/settings/validate-key", access: "OperatorAny", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/validate-key" },
	{ method: "POST", path: "/api/settings/upstream",    access: "OperatorAdmin", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/upstream" },
	{ method: "POST", path: "/api/settings/account",     access: "OperatorAny", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/account" },
	{ method: "POST", path: "/api/settings/locale",      access: "OperatorAdmin", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/locale" },

	/* API providers */
	{ method: "GET", path: "/api/providers",  access: "OperatorAdmin", phase: "PostSetup", openapi: true,  probe_path: "/api/providers" },

	/* API routing */
	{ method: "POST", path: "/api/settings/routing", access: "OperatorAdmin", phase: "PostSetup", openapi: true,  probe_path: "/api/settings/routing" },

	/* Auth routes */
	{ method: "GET",  path: "/health",    access: "Public", phase: "Always", openapi: false, probe_path: "/health" },
	{ method: "GET",  path: "/login",     access: "Public", phase: "Always", openapi: false, probe_path: "/login" },
	{ method: "POST", path: "/login",     access: "Public", phase: "Always", openapi: false, probe_path: "/login" },
	{ method: "POST", path: "/logout",    access: "Public", phase: "Always", openapi: false, probe_path: "/logout" },

	/* Setup routes */
	{ method: "GET",  path: "/setup",     access: "Public", phase: "PreSetup", openapi: false, probe_path: "/setup" },
	{ method: "POST", path: "/setup",     access: "Public", phase: "PreSetup", openapi: true,  probe_path: "/setup" },
	{ method: "POST", path: "/setup/validate-key", access: "Public", phase: "PreSetup", openapi: true,  probe_path: "/setup/validate-key" },

	/* Custom bodybuilder route */
	{ method: "POST", path: "/v1/custom/bodybuilder", access: "Client", phase: "PostSetup", openapi: false, probe_path: "/v1/custom/bodybuilder" },

	/* OpenAI-v1 passthrough wildcard */
	{ method: "ANY",  path: "/v1/{*path}", access: "Client", phase: "PostSetup", openapi: false, probe_path: "/v1/chat/completions" },
];