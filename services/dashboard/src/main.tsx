import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createDbPool, migrate } from "@tanren/db";
import { Hono } from "hono";
import { z } from "zod";
import { OrchestratorClient } from "./api/orchestrator.js";
import { mountShell, type ShellDeps } from "./app/mountShell.js";
import { loginUrl, useSession } from "./auth/index.js";

/** Public, unauthenticated paths (never gated by the auth middleware). */
const PUBLIC_PATHS = new Set(["/healthz", "/auth/login"]);

/** Body for the dashboard's forge-tools proxy (operator-button write actions). */
const ForgeToolProxyBody = z.object({
  orgId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({})
});

export interface CreateAppOptions {
  /** Pool override (tests pass a stub); defaults to the real DB pool. */
  pool?: ReturnType<typeof createDbPool>;
  /** Skip `migrate()` (tests). */
  skipMigrate?: boolean;
}

export async function createApp(options: CreateAppOptions = {}) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:3100";
  const requireAuth = process.env.TANREN_REQUIRE_AUTH === "1";
  const pool = options.pool ?? createDbPool();
  if (options.skipMigrate !== true) {
    await migrate(pool);
  }
  const app = new Hono();
  const shellDeps: ShellDeps = { orchestratorUrl };

  app.get("/healthz", async (c) => {
    const dbResult = await pool.query("SELECT 1 AS ok");
    const orchestrator = await fetch(`${orchestratorUrl}/healthz`).then((r) => r.ok).catch(() => false);
    return c.json({ service: "dashboard", ok: dbResult.rows[0]?.ok === 1, orchestrator });
  });

  // Client-islands bundle + token/shell stylesheets (built by build:client).
  // Registered only when the built bundle exists relative to cwd (production
  // `start` runs from the package dir); skipped under `app.request` tests where
  // assets are not served.
  if (existsSync("./dist/static")) {
    app.use("/static/*", serveStatic({ root: "./dist" }));
  }

  // Auth gate. Public paths and static assets pass through; everything else
  // requires a session when TANREN_REQUIRE_AUTH=1. Unauthenticated → orchestrator
  // OAuth login with a `next` back to the requested path (lands into the shell).
  app.use("*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path) || c.req.path.startsWith("/static/")) {
      return next();
    }
    if (!requireAuth) {
      return next();
    }
    const session = await useSession(c.req.header("cookie"), { orchestratorUrl });
    if (session === undefined) {
      return c.redirect(`/auth/login?next=${encodeURIComponent(c.req.path)}`);
    }
    return next();
  });

  app.get("/auth/login", (c) => c.redirect(loginUrl(orchestratorUrl, c.req.query("next") ?? "/")));

  // Operator-button write-action proxy: the palette POSTs here, we forward the
  // cookie to the orchestrator Forge tool surface (keeps the orchestrator URL
  // server-side and reuses the session cookie).
  app.post("/forge/tools", async (c) => {
    const parsed = ForgeToolProxyBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_tool_call", issues: parsed.error.issues }, 400);
    }
    const client = new OrchestratorClient({ orchestratorUrl, cookieHeader: c.req.header("cookie") });
    const result = await client.invokeForgeTool(parsed.data.orgId, parsed.data.tool, parsed.data.args);
    if (result === undefined) {
      return c.json({ error: "tool_invocation_failed" }, 502);
    }
    return c.json(result);
  });

  // Shell chrome routes (TopBar + SideNav + palette) and sidenav placeholders.
  // Child screens (P2B-0002…0009) register their own routes + reuse renderShell.
  mountShell(app, shellDeps);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.DASHBOARD_PORT ?? 3000);
  const app = await createApp();
  serve({ fetch: app.fetch, port });
  console.log(`dashboard listening on :${port}`);
}
