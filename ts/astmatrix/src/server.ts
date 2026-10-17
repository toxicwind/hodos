/**
 * astmatrix-ts — Bun sidecar entrypoint.
 *
 * Runs the ported AST Matrix router as an HTTP sidecar for the Rust flock
 * binary (flock/proxy). The Rust side proxies cloud-routing requests here;
 * this process owns strategies, racing, ELO, circuits, rate limiting, and
 * the health DB — the full behavioral port of herd/internal/astmatrix.
 *
 * Env:
 *   ASTMATRIX_PORT   listen port (default 25214)
 *   ASTMATRIX_STRATEGY default strategy (default "hybrid")
 *   (plus estate-scripts_LIVE_CATALOG, estate-scripts_CATALOG_404_URL,
 *    estate-scripts_CATALOG_ADMIN_TOKEN from live-catalog.ts)
 */
import { Router } from "./router.ts";
import { serveUI, uiData } from "./ui.ts";

const PORT = parseInt(process.env.ASTMATRIX_PORT || "25214", 10);

const router = Router.create({
  enabled: true,
  strategy: process.env.ASTMATRIX_STRATEGY || "hybrid",
});

function modelsList(): Response {
  const seen = new Set<string>();
  const data: Array<{ id: string; object: string; owned_by: string }> = [];
  for (const [pname, p] of Object.entries(router.getMatrix().providers)) {
    for (const mid of p.models) {
      const id = `${pname}/${mid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ id, object: "model", owned_by: pname });
    }
  }
  return Response.json({ object: "list", data });
}

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", ...router.uiData(), router: "astmatrix-ts" });
      }
      if (url.pathname === "/v1/models") return modelsList();
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        return router.handleRequest(req);
      }
      if (url.pathname === "/ui" || url.pathname === "/") return serveUI();
      if (url.pathname === "/ui/data") return uiData(router);
      if (url.pathname === "/admin/sync-catalog" && req.method === "POST") {
        router.getMatrix().syncLiveCatalog();
        return Response.json({ ok: true });
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
});

console.log(`astmatrix-ts sidecar listening on :${PORT}`);

process.on("SIGTERM", () => {
  router.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  router.close();
  process.exit(0);
});
