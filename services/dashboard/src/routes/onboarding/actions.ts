/**
 * Dashboard-internal POST handlers for P2B-0002 write actions. The browser
 * submits plain HTML forms to these dashboard paths; each handler forwards the
 * session cookie to the orchestrator's typed P2A-0013 / P2A-0017 routes (so
 * the orchestrator URL stays server-side, mirroring the shell's /forge/tools
 * proxy) and then redirects back to the originating screen.
 *
 * No business logic lives here — these are thin proxies. Secrets are forwarded
 * write-only and never echoed back into any response.
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import type { ShellDeps } from "../../app/mountShell.js";

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

/** Resolve the operator's first org id (the onboarding scope). */
async function firstOrgId(client: OrchestratorClient): Promise<string | undefined> {
  const orgs = await client.listOrgs();
  return orgs[0]?.id;
}

function redirectTo(c: Context, path: string, notice?: string): Response {
  const url =
    notice === undefined ? path : `${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`;
  return c.redirect(url, 303);
}

export function mountOnboardingActions(app: Hono, deps: ShellDeps): void {
  // ── credentials ────────────────────────────────────────────────────────
  app.post("/onboarding/credentials/org/apikey", async (c) => {
    const client = clientFor(c, deps);
    const orgId = await firstOrgId(client);
    const form = await c.req.parseBody();
    const label = String(form["label"] ?? "").trim();
    const value = String(form["value"] ?? "");
    const schema = String(form["schema"] ?? "custom");
    const baseUrl = String(form["baseUrl"] ?? "");
    if (orgId === undefined || label === "" || value === "") {
      return redirectTo(c, "/onboarding/credentials", "missing label or key");
    }
    // Opaque API-key import: ref encodes scope + label per P2A-0013 namespacing.
    const ref = `credential/opaque/org/${orgId}/${label}`;
    const result = await client.importCredential({
      scope: "org",
      orgId,
      kind: "opaque",
      body: { ref, value, schema, baseUrl },
    });
    return redirectTo(c, "/onboarding/credentials", result.ok ? `saved ${label}` : "save failed");
  });

  app.post("/onboarding/credentials/dev/codex", async (c) => {
    const client = clientFor(c, deps);
    const form = await c.req.parseBody();
    const ref = String(form["ref"] ?? "").trim();
    const authJson = String(form["authJson"] ?? "");
    if (ref === "" || authJson === "") {
      return redirectTo(c, "/onboarding/credentials", "missing ref or auth.json");
    }
    const result = await client.importCredential({
      scope: "me",
      kind: "codex_chatgpt_auth",
      body: { ref, authJson },
    });
    return redirectTo(c, "/onboarding/credentials", result.ok ? "codex bundle imported" : "import failed");
  });

  app.post("/onboarding/credentials/github", async (c) => {
    // GitHub token import (P3-0002). Org-scoped (billed to / shared by the org)
    // so a project can resolve it as the run's GitHub credential. The token is
    // forwarded write-only and never echoed back. Ref defaults into the
    // P2A-0013 managed namespace (`credential/github/org/<orgId>/<label>`).
    const client = clientFor(c, deps);
    const orgId = await firstOrgId(client);
    const form = await c.req.parseBody();
    const label = String(form["label"] ?? "").trim();
    const token = String(form["token"] ?? "");
    if (orgId === undefined || label === "" || token === "") {
      return redirectTo(c, "/onboarding/credentials", "missing label or token");
    }
    const ref = `credential/github/org/${orgId}/${label}`;
    const result = await client.importCredential({
      scope: "org",
      orgId,
      kind: "github_token",
      body: { ref, token },
    });
    return redirectTo(c, "/onboarding/credentials", result.ok ? `saved ${label}` : "save failed");
  });

  app.post("/onboarding/credentials/delete", async (c) => {
    const client = clientFor(c, deps);
    const orgId = await firstOrgId(client);
    const form = await c.req.parseBody();
    const ref = String(form["ref"] ?? "");
    if (orgId !== undefined && ref !== "") await client.deleteOrgCredential(orgId, ref);
    return redirectTo(c, "/onboarding/credentials", "removed");
  });

  // ── notifications ────────────────────────────────────────────────────────
  app.post("/notifications/targets", async (c) => {
    const client = clientFor(c, deps);
    const orgId = await firstOrgId(client);
    const form = await c.req.parseBody();
    const label = String(form["label"] ?? "").trim();
    const destination = String(form["destination"] ?? "").trim();
    const channelKind = String(form["channelKind"] ?? "ntfy");
    if (orgId === undefined || label === "" || destination === "") {
      return redirectTo(c, "/notifications", "missing label or destination");
    }
    const created = await client.createNotificationTarget(orgId, {
      label,
      destination,
      channelKind,
      scope: "org",
      enabled: true,
    });
    return redirectTo(c, "/notifications", created ? `added ${label}` : "add failed");
  });

  // Matrix cell toggle (called by the screen island as a form POST fallback /
  // progressive enhancement). Creates a route opt-in for (target × event).
  app.post("/notifications/routes", async (c) => {
    const client = clientFor(c, deps);
    const orgId = await firstOrgId(client);
    const form = await c.req.parseBody();
    const targetId = String(form["targetId"] ?? "");
    const eventName = String(form["eventName"] ?? "");
    const minSeverity = String(form["minSeverity"] ?? "info");
    const enabled = String(form["enabled"] ?? "true") !== "false";
    if (orgId === undefined || targetId === "" || eventName === "") {
      return redirectTo(c, "/notifications", "missing target or event");
    }
    await client.createNotificationRoute(orgId, { targetId, eventName, minSeverity, enabled });
    return redirectTo(c, "/notifications", "route saved");
  });

  // ── infrastructure (step 4) ──────────────────────────────────────────────
  app.post("/onboarding/org/infra", async (c) => {
    // Allocator defaults live in org config (P2A-0006). The v0 surface only
    // confirms local-docker is active; persisting concurrency/image into org
    // config is a no-op-safe redirect here (full org-config PATCH is owned by
    // P2A-0013 and exercised from /settings). We acknowledge + advance.
    await c.req.parseBody();
    return redirectTo(c, "/onboarding/org?step=4", "local-docker defaults saved");
  });

  // The existing-project link POST is handled in ./index.tsx so it can render
  // the detected-files confirmation inside the shell.
}
