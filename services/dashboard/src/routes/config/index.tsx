/**
 * P3-0017 mount: the tanren-config audit-gate surface + the Settings toggle.
 * Registered through the append-only screen registry (see `app/screens.ts`);
 * reuses `loadShellContext` + `renderShell` and never touches the chrome.
 *
 * Routes registered:
 *   GET  /settings/config          the config-as-code surface (gate-ON | gate-OFF)
 *   POST /settings/config/toggle   flip the audit-gate toggle (org config PATCH)
 *
 * Reads go through the typed `OrchestratorClient.getOrg`; the toggle is a
 * server-side form POST that PATCHes `organizations.config` (P2A-0013) and
 * redirects back. The gate-ON view's diff/PR is resolved from the org config +
 * the most recent gated PATCH response surfaced by the orchestrator (202).
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import type { OrgConfig } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { ConfigView, type ConfigDiffLine, type ConfigHistoryEntry } from "../../components/config/ConfigView.js";

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie")
  });
}

/** Static history shown until a config-PR event store lands (documented punt). */
const PLACEHOLDER_HISTORY: ConfigHistoryEntry[] = [
  { ref: "#6", summary: "raise max writer iter 5 → 8", who: "forge", when: "3d ago", state: "merged" },
  { ref: "#5", summary: "add gemini-2.5-pro as write fallback", who: "forge", when: "8d ago", state: "merged" },
  { ref: "#4", summary: "rotate openai org key reference", who: "operator", when: "12d ago", state: "merged" }
];

export function mountConfigScreen(app: Hono, deps: ShellDeps): void {
  // -------------------------------------------------------------------------
  // GET /settings/config — the config-as-code surface.
  // -------------------------------------------------------------------------
  app.get("/settings/config", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "settings" });
    let config: OrgConfig | undefined;
    if (ctx.org !== undefined) {
      config = (await clientFor(c, deps).getOrg(ctx.org.id))?.config;
    }
    const gateEnabled = config?.auditGateEnabled === true;
    const target = config?.auditGate;

    // The diff for any in-flight change is carried on the query string after a
    // gated PATCH (202) redirect, so the surface can show the just-opened PR.
    const prNumber = Number(c.req.query("pr") ?? "");
    const pr =
      Number.isFinite(prNumber) && prNumber > 0
        ? { number: prNumber, url: c.req.query("prUrl") ?? "#", branch: c.req.query("branch") ?? "" }
        : undefined;

    return renderShell(
      c,
      ctx,
      { title: "tanren · config as code" },
      <ConfigView
        orgId={ctx.org?.id ?? ""}
        orgLogin={ctx.org?.login ?? ""}
        gateEnabled={gateEnabled}
        repo={target?.repo}
        configFile={target?.configFile ?? "tanren.yaml"}
        pr={pr}
        rationale={c.req.query("rationale") ?? undefined}
        diff={decodeDiff(c.req.query("diff"))}
        checks={["schema valid", "no dangling cred refs", "fallback chain ≥ 1"]}
        impact={[
          { l: "scope", v: "config only", k: "applies on merge" },
          { l: "source of truth", v: "the db", k: "pr is the write gate" }
        ]}
        history={PLACEHOLDER_HISTORY}
      />
    );
  });

  // -------------------------------------------------------------------------
  // POST /settings/config/toggle — flip the gate on/off (org config PATCH).
  // -------------------------------------------------------------------------
  app.post("/settings/config/toggle", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "settings" });
    const form = await c.req.parseBody();
    const enable = String(form["enable"] ?? "") === "1";
    const repo = String(form["repo"] ?? "").trim();
    if (ctx.org !== undefined) {
      const client = clientFor(c, deps);
      const current = await client.getOrg(ctx.org.id);
      const config: OrgConfig = {
        version: 1,
        routing: current?.config.routing ?? emptyRouting(),
        escapeHatches: current?.config.escapeHatches ?? defaultHatches(),
        ...current?.config,
        auditGateEnabled: enable
      };
      // Enabling needs a target repo; carry it through (default branch/file).
      if (enable && repo !== "") {
        config.auditGate = { repo, baseBranch: "main", branchPrefix: "forge", configFile: "tanren.yaml" };
      } else if (!enable) {
        delete config.auditGate;
      }
      // Flipping the toggle is NOT a Bucket-B write, so this applies directly.
      await client.patchOrgConfig(ctx.org.id, config);
    }
    return c.redirect("/settings/config");
  });
}

function decodeDiff(raw: string | undefined): ConfigDiffLine[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as ConfigDiffLine[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function emptyRouting(): OrgConfig["routing"] {
  return {
    plan: { chain: [] },
    write: { chain: [] },
    check: { chain: [] },
    audit: { chain: [] },
    demo: { chain: [] },
    forge: { chain: [] }
  };
}

function defaultHatches(): OrgConfig["escapeHatches"] {
  return {
    maxWriterIterPerSubtask: 5,
    maxPlannerRerunsPerSpec: 3,
    maxRetriesPerTransientFailure: 3,
    maxSpecDiscoveryRoundsWithForge: 20
  };
}
