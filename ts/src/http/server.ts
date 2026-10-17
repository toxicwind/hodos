import type { RouteDescriptor } from "./routes.ts";
import { callUpstream, Result, UpstreamResponse } from "./shared.ts";
import type { ServerOptions } from "./shared.ts";

/** Route table — flat array of route descriptors, matching the Rust `routes.rs` ROUTES constant. */
export const ROUTES: RouteDescriptor[] = [
	/* Static assets (public) */
	{ method: "GET", path: "/assets/public/public.css",  access: "Public",    phase: "Always",    openapi: false },
	{ method: "GET", path: "/assets/public/noscript.css", access: "Public",    phase: "Always",    openapi: false },
	{ method: "GET", path: "/assets/public/setup.js",   access: "Public",    phase: "Always",    openapi: false },
	{ method: "GET", path: "/assets/public/login.js",   access: "Public",    phase: "Always",    openapi: false },
	{ method: "GET", path: "/assets/public/locales/{locale}.json", access: "Public", phase: "Always", openapi: false },

	/* Static assets (operator) */
	{ method: "GET", path: "/assets/operator/operator.css",  access: "OperatorAny", phase: "PostSetup", openapi: false },
	{ method: "GET", path: "/assets/operator/shared.js",      access: "OperatorAny", phase: "PostSetup", openapi: false },
	{ method: "GET", path: "/assets/operator/dashboard.js",   access: "OperatorAny", phase: "PostSetup", openapi: false },
	{ method: "GET", path: "/assets/operator/settings.js",    access: "OperatorAny", phase: "PostSetup", openapi: false },
	{ method: "GET", path: "/assets/operator/locales/{locale}.json", access: "OperatorAny", phase: "PostSetup", openapi: false },

	/* Root and dashboard */
	{ method: "GET", path: "/",               access: "OperatorAny", phase: "PostSetup", openapi: false },
	{ method: "GET", path: "/dash",           access: "OperatorAny", phase: "PostSetup", openapi: false },
	{ method: "GET", path: "/metrics",          access: "OperatorAny", phase: "PostSetup", openapi: false },

	/* API routes (dashboard) */
	{ method: "GET", path: "/api/dashboard",    access: "OperatorAny", phase: "PostSetup", openapi: true },
	{ method: "GET", path: "/api/dashboard/now", access: "OperatorAny", phase: "PostSetup", openapi: true },
	{ method: "GET", path: "/api/config",       access: "OperatorAny", phase: "PostSetup", openapi: true },
	{ method: "GET", path: "/api/locale-bootstrap", access: "Public", phase: "Always", openapi: true },

	/* API settings routes */
	{ method: "POST", path: "/api/settings/nim-keys",    access: "OperatorAny", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/clients",     access: "OperatorAny", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/limits",      access: "OperatorAdmin", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/server",      access: "OperatorAdmin", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/history",     access: "OperatorAdmin", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/governor",    access: "OperatorAdmin", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/users",       access: "OperatorAdmin", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/validate-key", access: "OperatorAny", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/upstream",    access: "OperatorAdmin", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/account",     access: "OperatorAny", phase: "PostSetup", openapi: true },
	{ method: "POST", path: "/api/settings/locale",      access: "OperatorAdmin", phase: "PostSetup", openapi: true },

	/* API providers */
	{ method: "GET", path: "/api/providers",  access: "OperatorAdmin", phase: "PostSetup", openapi: true },

	/* API routing */
	{ method: "POST", path: "/api/settings/routing", access: "OperatorAdmin", phase: "PostSetup", openapi: true },

	/* Auth routes */
	{ method: "GET",  path: "/health",    access: "Public", phase: "Always", openapi: false },
	{ method: "GET",  path: "/login",     access: "Public", phase: "Always", openapi: false },
	{ method: "POST", path: "/login",     access: "Public", phase: "Always", openapi: false },
	{ method: "POST", path: "/logout",    access: "Public", phase: "Always", openapi: false },

	/* Setup routes */
	{ method: "GET",  path: "/setup",     access: "Public", phase: "PreSetup", openapi: false },
	{ method: "POST", path: "/setup",     access: "Public", phase: "PreSetup", openapi: true },
	{ method: "POST", path: "/setup/validate-key", access: "Public", phase: "PreSetup", openapi: true },

	/* Custom bodybuilder route */
	{ method: "POST", path: "/v1/custom/bodybuilder", access: "Client", phase: "PostSetup", openapi: false },

	/* OpenAI-v1 passthrough wildcard */
	{ method: "ANY",  path: "/v1/{*path}", access: "Client", phase: "PostSetup", openapi: false },
];

/** Build a handler key from method+path for fast lookup. */
function handlerKey(method: string, path: string): string {
	return `${method.toUpperCase()}::${path}`;
}

/** Auth middleware: checks for valid Bearer token or "local" mode. */
async function authMiddleware(
	req: Request,
	state: { clients?: ReadonlyArray<{ digest: string; name: string }>; setupRequired: boolean },
): Promise<{ ok: boolean; user?: string }> {
	// Fail closed until first-time setup completes
	if (state.setupRequired) {
		return { ok: false };
	}

	// Open mode admits everyone as "local"
	if (!state.clients) {
		return { ok: true, user: "local" };
	}

	const auth = req.headers.get("authorization");
	if (!auth?.startsWith("Bearer ")) {
		return { ok: false };
	}

	const token = auth.slice("Bearer ".length);
	const digest = Buffer.from(token, "utf-8").toString("hex").padStart(64, "0");

	for (const { digest: stored, name } of state.clients) {
		if (digest === stored) {
			return { ok: true, user: name };
		}
	}

	return { ok: false };
}

/** JSON error envelope — port of `ApiError` from `api.rs`. */
function jsonError(status: number, code: string, message: string): Response {
	const body = JSON.stringify({ error: { message, type: code, code } });
	return new Response(body, {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Route handler dispatcher. */
async function handleRoute(
	req: Request,
	routes: RouteDescriptor[],
	state: Awaited<ReturnType<typeof getState>>,
): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname; // e.g. "/v1/chat/completions"
	const method = req.method as "GET" | "POST" | "ANY";

	// Special case: /v1/{*path} — forward to callUpstream
	if (method === "ANY" && path === "/v1/{*path}") {
		// The actual path is the remainder after /v1/
		const segments = url.pathname.split("/");
		if (segments.length >= 3) {
			const actualPath = "/" + segments.slice(2).join("/"); // /v1/chat/completions -> /chat/completions
			return forwardToUpstream(req, actualPath);
		}
		return jsonError(400, "bad_request", "malformed /v1/ path");
	}

	// Find matching route
	const route = routes.find(
		(r) => r.method === method || method === "ANY" && r.path === path || r.path === path,
	);

	if (!route) {
		return jsonError(404, "not_found", "not found");
	}

	// Auth check
	const auth = await authMiddleware(req, state);
	if (!auth.ok) {
		return jsonError(401, "unauthorized", "unauthorized");
	}

	// Route-specific handling
	switch (path) {
		case "/health":
			return healthHandler();
		case "/login":
			return loginHandler(req, method);
		case "/logout":
			return logoutHandler();
		case "/setup":
			return setupHandler(req, method);
		case "/api/config":
			return configHandler();
		case "/api/locale-bootstrap":
			return localeBootstrapHandler();
		case "/api/dashboard":
			return dashboardHandler();
		case "/api/dashboard/now":
			return dashboardNowHandler();
		case "/api/providers":
			return providersHandler();
		case "/api/settings/routing":
			return routingHandler();
		case "/v1/{*path}":
			// Already handled above via special case
			return jsonError(404, "not_found", "not found");
		default:
			// Forward to upstream for /v1/* paths
			return forwardToUpstream(req, path);
	}
}

/** Forward request to upstream via callUpstream. */
async function forwardToUpstream(
	req: Request,
	upstreamPath: string,
): Promise<Response> {
	// Build upstream request through callUpstream
	const upstreamReq = {
		path: upstreamPath,
		method: req.method,
		headers: req.headers as any,
		body: req.body,
		signal: req.signal,
	} as const;

	try {
		const upstreamResp = await callUpstream(upstreamReq, req.signal);
		const bodyStream = upstreamResp.body
			? new NodeJS.ReadableStream({
				start(controller) {
					// This is a simplification; real impl would pipe the stream
				},
			})
			: null;

		return new Response(bodyStream, {
			status: upstreamResp.status,
			headers: upstreamResp.headers,
		});
	} catch (e) {
		return jsonError(502, "bad_gateway", String(e));
	}
}

/** Health check handler. */
function healthHandler(): Response {
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Login handler. */
async function loginHandler(req: Request, method: string): Promise<Response> {
	if (method === "GET") {
		return new Response(`<html><body>Login page</body></html>`, {
			headers: { "Content-Type": "text/html" },
		});
	}
	// POST /login — authenticate
	const body = await req.json();
	// Simplified: accept any creds in open mode
	return new Response(JSON.stringify({ ok: true, token: "session-token" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Logout handler. */
function logoutHandler(): Response {
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Setup handler. */
async function setupHandler(req: Request, method: string): Promise<Response> {
	if (method === "GET") {
		return new Response(`<html><body>Setup page</body></html>`, {
			headers: { "Content-Type": "text/html" },
		});
	}
	// POST /setup — first-run claim
	const body = await req.json();
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Config handler. */
function configHandler(): Response {
	return new Response(JSON.stringify({ ok: true, config: {} }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Locale bootstrap handler. */
function localeBootstrapHandler(): Response {
	return new Response(JSON.stringify({ ok: true, locale: "en-US" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Dashboard handler. */
function dashboardHandler(): Response {
	return new Response(JSON.stringify({ ok: true, dashboards: [] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Dashboard now handler. */
function dashboardNowHandler(): Response {
	return new Response(JSON.stringify({ ok: true, now: {} }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Providers handler. */
function providersHandler(): Response {
	return new Response(JSON.stringify({ ok: true, providers: [] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Routing handler. */
function routingHandler(): Response {
	return new Response(JSON.stringify({ ok: true, routing: {} }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Get app state (simplified). */
function getState(): Promise<{ clients?: ReadonlyArray<{ digest: string; name: string }>; setupRequired: boolean }> {
	return Promise.resolve({ clients: undefined, setupRequired: false });
}

/** Start the Bun server. */
export function startServer(opts: ServerOptions): { port: number; stop(): Promise<void> } {
	const { port, routes, onRequest } = opts;

	return Bun.serve({
		port,
		async fetch(req) {
			if (onRequest) {
				onRequest(req);
			}

			// Route handling
			return handleRoute(req, routes, getState());
		},
	});
}

/** Export types used by tests */
export type { RouteDescriptor, RouteMethod, RouteAccess, RoutePhase };

/** Test ROUTES parity check — this gets pulled in by the test suite. */
export function assertRoutesParity(rustRoutes: RouteDescriptor[], tsRoutes: RouteDescriptor[]): void {
	// Compare (method, path) sets
	const rustSet = new Set(rustRoutes.map((r) => `${r.method}::${r.path}`));
	const tsSet = new Set(tsRoutes.map((r) => `${r.method}::${r.path}`));

	if (!rustSet.equals(tsSet)) {
		const onlyInRust = [...rustSet].filter((x) => !tsSet.has(x));
		const onlyInTS = [...tsSet].filter((x) => !rustSet.has(x));
		throw new Error(
			`Route set mismatch: only in Rust: ${onlyInRust.join(", ")}; only in TS: ${onlyInTS.join(", ")}`,
		);
	}
}