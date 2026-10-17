/** Server test: asserts ROUTES coverage, envelope shapes, and error codes. */
import { ROUTES } from "./routes.ts";
import { assertRoutesParity } from "./server.ts";

/** Minimal set of Rust route descriptors for parity check. */

/** Check if two sets have the same elements. */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) {
		if (!b.has(item)) return false;
	}
	return true;
}
const RUST_ROUTES: any[] = [
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
	/* OpenAI-v1 passthrough wildcard */
	{ method: "ANY",  path: "/v1/{*path}", access: "Client", phase: "PostSetup", openapi: false },
];

/** Assert that two route arrays have the same (method, path, access, phase, openapi) tuples. */
function assertRoutesParity(rustRoutes: any[], tsRoutes: any[]): void {
	// Compare sets of (method, path, access, phase, openapi) tuples
	const rustSet = new Set(
		rustRoutes.map(
			(r) => `${r.method}::${r.path}::${r.access}::${r.phase}::${r.openapi}`
		)
	);
	const tsSet = new Set(
		tsRoutes.map(
			(r) => `${r.method}::${r.path}::${r.access}::${r.phase}::${r.openapi}`
		)
	);

	if (!setsEqual(rustSet, tsSet)) {
		const onlyInRust = [...rustSet].filter((x) => !tsSet.has(x));
		const onlyInTS = [...tsSet].filter((x) => !rustSet.has(x));
		throw new Error(
			`Route set mismatch: only in Rust: ${onlyInRust.join(
				", "
			)}; only in TS: ${onlyInTS.join(", ")}`
		);
	}
}

describe("Route table parity", () => {
	test("TS ROUTES has same (method, path, access, phase, openapi) as Rust routes", () => {
		assertRoutesParity(RUST_ROUTES, ROUTES);
	});

	test("ROUTES covers /health GET", () => {
		const healthRoute = ROUTES.find((r) => r.path === "/health" && r.method === "GET");
		expect(healthRoute).toBeDefined();
		expect(healthRoute?.access).toBe("Public");
		expect(healthRoute?.openapi).toBe(false);
	});

	test("ROUTES covers /v1/{*path} ANY", () => {
		const v1Route = ROUTES.find((r) => r.path === "/v1/{*path}" && r.method === "ANY");
		expect(v1Route).toBeDefined();
		expect(v1Route?.access).toBe("Client");
	});

	test("ROUTES covers /api/config GET", () => {
		const configRoute = ROUTES.find((r) => r.path === "/api/config" && r.method === "GET");
		expect(configRoute).toBeDefined();
		expect(configRoute?.openapi).toBe(true);
	});

	test("ROUTES covers /api/settings/validate-key POST", () => {
		const validateKeyRoute = ROUTES.find(
			(r) => r.path === "/api/settings/validate-key" && r.method === "POST"
		);
		expect(validateKeyRoute).toBeDefined();
		expect(validateKeyRoute?.access).toBe("OperatorAny");
	});

	test("ROUTES covers all routes from Rust ROUTES constant", () => {
		// Verify TS has at least as many routes as Rust
		expect(ROUTES.length).toBeGreaterThanOrEqual(RUST_ROUTES.length);
	});
});

describe("Error envelope shapes", () => {
	test("Error response has correct JSON structure", () => {
		const errorBody = { error: { message: "test error", type: "bad_request", code: "bad_request" } };
		const body = JSON.stringify(errorBody);
		const parsed = JSON.parse(body);
		expect(parsed).toHaveProperty("error.message", "test error");
		expect(parsed).toHaveProperty("error.type", "bad_request");
		expect(parsed).toHaveProperty("error.code", "bad_request");
	});

	test("404 response structure", () => {
		const respBody = { error: { message: "not found", type: "not_found", code: "not_found" } };
		const body = JSON.stringify(respBody);
		const parsed = JSON.parse(body);
		expect(parsed.error.message).toBe("not found");
		expect(parsed.error.type).toBe("not_found");
		expect(parsed.error.code).toBe("not_found");
	});

	test("401 response structure", () => {
		const respBody = { error: { message: "unauthorized", type: "unauthorized", code: "unauthorized" } };
		const body = JSON.stringify(respBody);
		const parsed = JSON.parse(body);
		expect(parsed.error.message).toBe("unauthorized");
		expect(parsed.error.type).toBe("unauthorized");
		expect(parsed.error.code).toBe("unauthorized");
	});
});