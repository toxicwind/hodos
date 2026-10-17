/** Route table parity test against `routes.rs` ROUTES constant. */
import { ROUTES as TS_ROUTES } from "./routes.ts";

/** Route descriptor matching the Rust `RouteContract` fields used in parity check. */
interface RustRoute {
	method: string;
	path: string;
	access: "Public" | "OperatorAny" | "OperatorAdmin" | "Client";
	phase: "Always" | "PreSetup" | "PostSetup";
	openapi: boolean;
}

/** The full Rust ROUTES constant reconstructed from `routes.rs` constants. */
const RUST_ROUTES: RustRoute[] = [
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

/** Check if two sets have the same elements. */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) {
		if (!b.has(item)) return false;
	}
	return true;
}

/** Assert that the TS ROUTES table has the same (method, path, access, phase, openapi) as the Rust one. */
function assertRouteParity(): void {
	// Compare sets of (method, path, access, phase, openapi) tuples
	const rustSet = new Set(
		RUST_ROUTES.map(
			(r) => `${r.method}::${r.path}::${r.access}::${r.phase}::${r.openapi}`
		)
	);
	const tsSet = new Set(
		TS_ROUTES.map(
			(r) => `${r.method}::${r.path}::${r.access}::${r.phase}::${r.openapi}`
		)
	);

	if (!setsEqual(rustSet, tsSet)) {
		const onlyInRust = [...rustSet].filter((x) => !tsSet.has(x));
		const onlyInTS = [...tsSet].filter((x) => !rustSet.has(x));
		throw new Error(
			`Route parity failed: only in Rust: ${onlyInRust.join(
				", "
			)}; only in TS: ${onlyInTS.join(", ")}`
		);
	}
}

describe("Route parity", () => {
	test("TS ROUTES has same method+path+access+phase+openapi as Rust ROUTES", () => {
		assertRouteParity();
	});
});