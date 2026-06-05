import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createDbPool, migrate } from "@tanren/db";
import { Hono } from "hono";
import { z } from "zod";
import { OrchestratorClient } from "./api/orchestrator.js";
import { mountShell, type ShellDeps } from "./app/mountShell.js";
import { mountScreens } from "./app/screens.js";
import { devLoginEnabled, devLoginHandshake, loginUrl, useSession } from "./auth/index.js";

/** Public, unauthenticated paths (never gated by the auth middleware). */
const PUBLIC_PATHS = new Set(["/healthz", "/auth/login", "/signin"]);

/** Body for the dashboard's forge-tools proxy (operator-button write actions). */
const ForgeToolProxyBody = z.object({
  orgId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

/** Body for the dashboard's thick-Forge chat proxy (⌘K chat morph). */
const ForgeAskProxyBody = z.object({
  orgId: z.string().min(1),
  question: z.string().min(1).max(4000),
  projectId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

/** Body for the proposal approve/reject proxy (write-action approval). */
const ForgeProposalDecisionBody = z.object({
  orgId: z.string().min(1),
  proposalId: z.string().min(1),
});

export interface CreateAppOptions {
  /** Pool override (tests pass a stub); defaults to the real DB pool. */
  pool?: ReturnType<typeof createDbPool>;
  /** Skip `migrate()` (tests). */
  skipMigrate?: boolean;
}

export async function createApp(options: CreateAppOptions = {}) {
  const orchestratorUrl = process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3100";
  const requireAuth = process.env["TANREN_REQUIRE_AUTH"] === "1";
  const pool = options.pool ?? createDbPool();
  if (options.skipMigrate !== true) {
    await migrate(pool);
  }
  const app = new Hono();
  const shellDeps: ShellDeps = { orchestratorUrl };

  app.get("/healthz", async (c) => {
    const dbResult = await pool.query("SELECT 1 AS ok");
    const orchestrator = await fetch(`${orchestratorUrl}/healthz`)
      .then((r) => r.ok)
      .catch(() => false);
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
      // DEV-ONLY: when the escape hatch is on, send unauthenticated operators to
      // a visible sign-in page with a one-click "sign in (dev)" button instead of
      // bouncing straight through. github_oauth behavior (flag off) is unchanged.
      if (devLoginEnabled()) {
        return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`);
      }
      return c.redirect(`/auth/login?next=${encodeURIComponent(c.req.path)}`);
    }
    return next();
  });

  // DEV-ONLY: when the local_dev escape hatch is enabled the orchestrator runs on a
  // different (docker-internal) origin than the browser, so a cross-origin redirect
  // would 302 the browser to an unresolvable host. Instead run the whole login→callback
  // handshake server-side (BFF proxy) against the internal ORCHESTRATOR_URL and
  // re-emit the minted session cookie on the dashboard's own (localhost) origin, then
  // 303 the browser to the dashboard-relative `next`. The github_oauth path is left
  // untouched: real OAuth REQUIRES the browser to visit GitHub, so it still redirects.
  app.get("/auth/login", async (c) => {
    const next = c.req.query("next") ?? "/";
    if (!devLoginEnabled()) {
      return c.redirect(loginUrl(orchestratorUrl, next));
    }
    try {
      const result = await devLoginHandshake(orchestratorUrl, next);
      // Re-emit the orchestrator's session Set-Cookie verbatim on our origin so the
      // browser stores it on the shared `localhost` host (valid for every port).
      c.header("Set-Cookie", result.sessionSetCookie);
      return c.redirect(result.next, 303);
    } catch {
      // Never leak the internal orchestrator URL — bounce back to the visible
      // sign-in page with a generic error to render.
      return c.redirect(`/signin?next=${encodeURIComponent(next)}&error=dev_login_failed`);
    }
  });

  // DEV-ONLY sign-in landing: a visible one-click affordance that drives the
  // orchestrator's local_dev provider (through /auth/login). Only reachable when
  // TANREN_DEV_LOGIN=1 — otherwise it 404s and operators use github_oauth.
  app.get("/signin", (c) => {
    if (!devLoginEnabled()) {
      return c.notFound();
    }
    const next = c.req.query("next") ?? "/";
    const href = `/auth/login?next=${encodeURIComponent(next)}`;
    const hasError = c.req.query("error") !== undefined;
    return c.html(
      <html lang="en" data-theme="dark">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>tanren · sign in (dev)</title>
          <link rel="stylesheet" href="/static/tokens.css" />
          <link rel="stylesheet" href="/static/shell.css" />
        </head>
        <body>
          <main class="main" style="display:grid;place-items:center;min-height:100vh">
            <section class="placeholder-card" style="text-align:center;max-width:32rem">
              <div class="eyebrow">dev login</div>
              <h1 class="page-title">tanren</h1>
              <p>Dev sign-in escape hatch is enabled. No GitHub OAuth app required.</p>
              {hasError ? (
                <p class="error" data-testid="signin-error" style="color:var(--color-danger,#f87171)">
                  Sign-in did not complete. Check that the orchestrator is up, then try again.
                </p>
              ) : null}
              <p>
                <a class="forge-key" href={href} data-testid="dev-signin">
                  sign in (dev)
                </a>
              </p>
            </section>
          </main>
        </body>
      </html>,
    );
  });

  // Operator-button write-action proxy: the palette POSTs here, we forward the
  // cookie to the orchestrator Forge tool surface (keeps the orchestrator URL
  // server-side and reuses the session cookie).
  app.post("/forge/tools", async (c) => {
    const parsed = ForgeToolProxyBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_tool_call", issues: parsed.error.issues }, 400);
    }
    const client = new OrchestratorClient({
      orchestratorUrl,
      cookieHeader: c.req.header("cookie"),
    });
    const result = await client.invokeForgeTool(parsed.data.orgId, parsed.data.tool, parsed.data.args);
    if (result === undefined) {
      return c.json({ error: "tool_invocation_failed" }, 502);
    }
    return c.json(result);
  });

  // thick-Forge chat proxy: the ⌘K chat morph POSTs the operator's
  // question here, we forward the cookie to the orchestrator's LLM-backed
  // conversation endpoint and return the forge turn's ForgeAnswer render.
  app.post("/forge/ask", async (c) => {
    const parsed = ForgeAskProxyBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_ask", issues: parsed.error.issues }, 400);
    }
    const client = new OrchestratorClient({
      orchestratorUrl,
      cookieHeader: c.req.header("cookie"),
    });
    const result = await client.askForge(
      parsed.data.orgId,
      parsed.data.question,
      { projectId: parsed.data.projectId, runId: parsed.data.runId },
      parsed.data.threadId,
    );
    if (result === undefined) {
      return c.json({ error: "forge_ask_failed" }, 502);
    }
    return c.json(result);
  });

  // write-action approval: approve/reject a proposed write. The palette
  // island POSTs here; we forward the cookie to the orchestrator's decision
  // route (which authz's + executes under the approving operator). Idempotent —
  // an already-decided proposal surfaces as `already_decided`, never a re-run.
  for (const decision of ["approve", "reject"] as const) {
    app.post(`/forge/proposals/${decision}`, async (c) => {
      const parsed = ForgeProposalDecisionBody.safeParse(await c.req.json().catch(() => {}));
      if (!parsed.success) {
        return c.json({ error: "invalid_decision", issues: parsed.error.issues }, 400);
      }
      const client = new OrchestratorClient({ orchestratorUrl, cookieHeader: c.req.header("cookie") });
      const result = await client.decideForgeProposal(parsed.data.orgId, parsed.data.proposalId, decision);
      const httpStatus =
        result.outcome === "decided"
          ? 200
          : result.outcome === "already_decided"
            ? 409
            : result.outcome === "denied"
              ? 403
              : result.outcome === "not_found"
                ? 404
                : 502;
      return c.json(result, httpStatus);
    });
  }

  // Child screens FIRST, via the append-only screen registry,
  // so their real routes claim their paths before the shell fills the gaps.
  mountScreens(app, shellDeps);

  // Shell chrome routes (TopBar + SideNav + palette) + gap-filling placeholders
  // for every sidenav row no child screen has claimed yet.
  mountShell(app, shellDeps);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env["DASHBOARD_PORT"] ?? 3000);
  const app = await createApp();
  serve({ fetch: app.fetch, port });
  console.log(`dashboard listening on :${port}`);
}
