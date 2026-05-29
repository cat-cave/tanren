/**
 * P2B-0003 mount: the chat-primary project view, the spec creation surface +
 * spec list, and the routing & limits settings — all registered through the
 * append-only screen registry (see `app/screens.ts`). Routes reuse the shell's
 * `loadShellContext` + `renderShell` and never touch the chrome. Backend reads
 * go through the typed `OrchestratorClient` (extended additively); writes are
 * server-side form POSTs that call P2A-0013/0019 and redirect back.
 *
 * P3-0013 adds a DAG-primary mode (`?mode=dag` + persisted cookie) and
 * delegates the spec drawer / full-page routes to `./specRoutes`.
 *
 * Routes registered:
 *   GET  /projects/:projectId                          project view (chat | dag)
 *   GET  /projects/:projectId/specs                    spec list
 *   GET  /projects/:projectId/specs/new                spec creation form
 *   POST /projects/:projectId/specs                    create spec (→ P2A-0013)
 *   POST /projects/:projectId/insights/act             subopt callout action (→ P2A-0019)
 *   GET  /settings/routing                             routing & limits (active project)
 *   GET  /settings/routing/:projectId                  routing & limits (explicit project)
 *   POST /settings/routing/:projectId/add|remove|reorder|hatches  config mutations (→ P2A-0013/0006)
 *   POST /settings/routing/:projectId/credentials                 bind codex+github refs (P3-0002)
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import { getProjectDag } from "../../api/projectDag.js";
import {
  ROLE_IDS,
  type EscapeHatches,
  type ProjectConfig,
  type RoleId,
  type RoutingChainEntry,
  type RoutingTable
} from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { ProjectDagBody } from "../../components/project/ProjectDagBody.js";
import { ProjectViewBody } from "../../components/project/ProjectViewBody.js";
import { buildProjectViewModel, sumRunCosts } from "../../components/project/projectViewData.js";
import { ESCAPE_HATCH_DEFAULTS, SettingsBody } from "../../components/project/SettingsBody.js";
import { SpecCreateBody, SpecListBody } from "../../components/project/SpecCreateBody.js";
import { mountSpecDetailRoutes, notFoundBody, resolveProjectMode } from "./specRoutes.js";

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie")
  });
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter((v) => v.length > 0);
}

export function mountProjectScreens(app: Hono, deps: ShellDeps): void {
  // -------------------------------------------------------------------------
  // Chat-primary project view (overrides the P2B-0001 placeholder).
  // -------------------------------------------------------------------------
  app.get("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(
        c,
        ctx,
        { title: `tanren · ${projectId}` },
        <div class="p2b">
          <div class="page-head">
            <div>
              <div class="eyebrow">project · not found</div>
              <div class="page-title">project not found</div>
            </div>
          </div>
          <div class="page-body">
            <section class="placeholder-card">
              <p>No project {projectId} is visible to you.</p>
            </section>
          </div>
        </div>
      );
    }
    const orgId = ctx.org.id;
    const client = clientFor(c, deps);
    const mode = resolveProjectMode(c);
    const [runs, insights, milestones, feed, narration] = await Promise.all([
      client.listRuns(orgId, projectId),
      client.listInsights(orgId, projectId),
      client.listMilestones(orgId, projectId),
      client.listFeed(orgId, projectId),
      client.generateProjectNarration(orgId, projectId)
    ]);
    const model = buildProjectViewModel({
      projectId,
      projectName: ctx.project.name,
      runs,
      insights,
      milestones,
      feed,
      narration,
      weekSpendUsd: sumRunCosts(runs)
    });
    if (mode === "dag") {
      const dag = await getProjectDag(client, orgId, projectId);
      return renderShell(
        c,
        ctx,
        { title: `tanren · ${ctx.project.name} · dag` },
        <ProjectDagBody projectId={projectId} projectName={ctx.project.name} dag={dag} model={model} />
      );
    }
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${ctx.project.name}` },
      <ProjectViewBody projectId={projectId} projectName={ctx.project.name} orgId={orgId} model={model} insights={insights} />
    );
  });

  // -------------------------------------------------------------------------
  // Spec list.
  // -------------------------------------------------------------------------
  app.get("/projects/:projectId/specs", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · specs" }, notFoundBody(projectId));
    }
    const client = clientFor(c, deps);
    const [specs, runs] = await Promise.all([
      client.listSpecs(ctx.org.id, projectId),
      client.listRuns(ctx.org.id, projectId)
    ]);
    const runBySpec: Record<string, string | undefined> = {};
    for (const run of runs) {
      if (runBySpec[run.specId] === undefined) runBySpec[run.specId] = run.runId;
    }
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${ctx.project.name} specs` },
      <SpecListBody project={ctx.project} specs={specs} runBySpec={runBySpec} />
    );
  });

  // -------------------------------------------------------------------------
  // Spec creation form.
  // -------------------------------------------------------------------------
  app.get("/projects/:projectId/specs/new", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · new spec" }, notFoundBody(projectId));
    }
    const client = clientFor(c, deps);
    const [milestones, behaviors, specs] = await Promise.all([
      client.listMilestones(ctx.org.id, projectId),
      client.listAllBehaviors(ctx.org.id, projectId),
      client.listSpecs(ctx.org.id, projectId)
    ]);
    return renderShell(
      c,
      ctx,
      { title: `tanren · new spec` },
      <SpecCreateBody project={ctx.project} milestones={milestones} behaviors={behaviors} specs={specs} />
    );
  });

  // P3-0013 spec drawer fragment + full-page spec view (split into specRoutes
  // to stay under the line cap). Registered after `/specs/new` so the static
  // route is not shadowed by the `:specId` param route.
  mountSpecDetailRoutes(app, deps);

  // -------------------------------------------------------------------------
  // Create spec (POST → P2A-0013). Re-renders the form with an error banner on
  // failure; redirects to the spec list on success.
  // -------------------------------------------------------------------------
  app.post("/projects/:projectId/specs", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · new spec" }, notFoundBody(projectId));
    }
    const form = await c.req.parseBody({ all: true });
    const title = String(form["title"] ?? "").trim();
    const description = String(form["description"] ?? "").trim();
    const acceptanceCriteria = asArray(form["acceptanceCriteria"] as string | string[] | undefined);
    const dependsOn = asArray(form["dependsOn"] as string | string[] | undefined);
    const milestoneId = String(form["milestoneId"] ?? "");

    const client = clientFor(c, deps);
    const reRender = (error: string) =>
      renderForm(c, ctx, deps, projectId, error, {
        title,
        description,
        acceptanceCriteria,
        milestoneId
      });

    if (title === "" || description === "" || acceptanceCriteria.length === 0) {
      return reRender("title, description, and at least one acceptance criterion are required.");
    }

    const result = await client.createSpec(ctx.org.id, projectId, {
      title,
      description,
      acceptanceCriteria,
      ...(dependsOn.length > 0 ? { dependsOn } : {})
    });
    if (!result.ok) {
      return reRender(
        result.status === 0
          ? "could not reach the orchestrator. try again."
          : `spec creation failed (status ${result.status}).`
      );
    }
    // Milestone + behavior associations are carried as form fields; the
    // create-spec route persists the spec, and the run-detail loader already
    // reads spec↔milestone/behavior links from P2A-0018 join tables. v0 leaves
    // the association write to the planner; the operator's selections are
    // forwarded but not yet bound here (documented punt — see PR body).
    return c.redirect(`/projects/${projectId}/specs`);
  });

  // -------------------------------------------------------------------------
  // Suboptimal-callout action: proxy the carried Forge tool call to P2A-0019
  // via the dashboard's existing /forge/tools proxy contract, then redirect
  // back to the project view.
  // -------------------------------------------------------------------------
  app.post("/projects/:projectId/insights/act", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = String(form["orgId"] ?? "");
    const tool = String(form["tool"] ?? "");
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(form["args"] ?? "{}")) as Record<string, unknown>;
    } catch {
      args = {};
    }
    if (orgId !== "" && tool !== "") {
      const client = clientFor(c, deps);
      await client.invokeForgeTool(orgId, tool, args);
    }
    return c.redirect(`/projects/${projectId}`);
  });

  // -------------------------------------------------------------------------
  // Routing & limits — active project shortcut + explicit project route.
  // -------------------------------------------------------------------------
  app.get("/settings/routing", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "settings" });
    const project = ctx.projects[0];
    if (ctx.org === undefined || project === undefined) {
      return renderShell(
        c,
        ctx,
        { title: "tanren · routing & limits" },
        <div class="p2b">
          <div class="page-head">
            <div>
              <div class="eyebrow">▮ settings · routing &amp; limits</div>
              <div class="page-title">no project yet</div>
            </div>
          </div>
          <div class="page-body">
            <section class="placeholder-card">
              <p>Link a project first — routing chains are per-project. <a href="/onboarding/existing">link a repo ↗</a></p>
            </section>
          </div>
        </div>
      );
    }
    return c.redirect(`/settings/routing/${project.projectId}`);
  });

  app.get("/settings/routing/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "settings", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · routing & limits" }, notFoundBody(projectId));
    }
    const client = clientFor(c, deps);
    const [detail, orgCredentials, org] = await Promise.all([
      client.getProject(ctx.org.id, projectId),
      client.listOrgCredentials(ctx.org.id),
      client.getOrg(ctx.org.id)
    ]);
    const { routing, escapeHatches } = resolveConfig(detail?.config);
    const boundCredentials = detail?.config?.credentials ?? {};
    const saved = c.req.query("saved") === "1";
    // P3-0017: surface the org audit-gate state so the toggle reflects reality.
    const auditGate = org?.config.auditGateEnabled === true;
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${ctx.project.name} routing` },
      <SettingsBody
        project={ctx.project}
        routing={routing}
        escapeHatches={escapeHatches}
        orgId={ctx.org.id}
        auditGate={auditGate}
        auditGateRepo={org?.config.auditGate?.repo}
        saved={saved}
        orgCredentials={orgCredentials}
        boundCredentials={boundCredentials}
      />
    );
  });

  // -------------------------------------------------------------------------
  // Config mutations — add / remove / reorder a chain entry, save hatches.
  // Each loads the merged config, applies the edit, PATCHes it back.
  // -------------------------------------------------------------------------
  app.post("/settings/routing/:projectId/add", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = String(form["orgId"] ?? "");
    const role = String(form["role"] ?? "") as RoleId;
    const entry: RoutingChainEntry = {
      cli: String(form["cli"] ?? "").trim(),
      model: String(form["model"] ?? "").trim(),
      authRef: String(form["authRef"] ?? "").trim()
    };
    await mutateConfig(c, deps, orgId, projectId, (config) => {
      if (ROLE_IDS.includes(role) && entry.cli !== "" && entry.model !== "" && entry.authRef !== "") {
        config.routing[role].chain.push(entry);
      }
    });
    return c.redirect(`/settings/routing/${projectId}?saved=1`);
  });

  app.post("/settings/routing/:projectId/remove", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = String(form["orgId"] ?? "");
    const role = String(form["role"] ?? "") as RoleId;
    const index = Number(form["index"] ?? "-1");
    await mutateConfig(c, deps, orgId, projectId, (config) => {
      if (ROLE_IDS.includes(role)) {
        const chain = config.routing[role].chain;
        if (index >= 0 && index < chain.length) chain.splice(index, 1);
      }
    });
    return c.redirect(`/settings/routing/${projectId}?saved=1`);
  });

  app.post("/settings/routing/:projectId/reorder", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = String(form["orgId"] ?? "");
    const role = String(form["role"] ?? "") as RoleId;
    const index = Number(form["index"] ?? "-1");
    const direction = String(form["direction"] ?? "");
    await mutateConfig(c, deps, orgId, projectId, (config) => {
      if (!ROLE_IDS.includes(role)) return;
      const chain = config.routing[role].chain;
      const target = direction === "up" ? index - 1 : index + 1;
      if (index >= 0 && index < chain.length && target >= 0 && target < chain.length) {
        const [moved] = chain.splice(index, 1);
        if (moved !== undefined) chain.splice(target, 0, moved);
      }
    });
    return c.redirect(`/settings/routing/${projectId}?saved=1`);
  });

  // Bind the project's Codex + GitHub credential refs (P3-0002). An empty
  // submitted value clears the binding so the run inherits the org default.
  app.post("/settings/routing/:projectId/credentials", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = String(form["orgId"] ?? "");
    const codexCredentialRef = String(form["codexCredentialRef"] ?? "").trim();
    const githubCredentialRef = String(form["githubCredentialRef"] ?? "").trim();
    await mutateConfig(c, deps, orgId, projectId, (config) => {
      const credentials: { codexCredentialRef?: string; githubCredentialRef?: string } = {};
      if (codexCredentialRef !== "") credentials.codexCredentialRef = codexCredentialRef;
      if (githubCredentialRef !== "") credentials.githubCredentialRef = githubCredentialRef;
      if (Object.keys(credentials).length === 0) {
        delete config.credentials;
      } else {
        config.credentials = credentials;
      }
    });
    return c.redirect(`/settings/routing/${projectId}?saved=1`);
  });

  app.post("/settings/routing/:projectId/hatches", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = String(form["orgId"] ?? "");
    await mutateConfig(c, deps, orgId, projectId, (config) => {
      const next: Partial<EscapeHatches> = { ...config.escapeHatches };
      for (const field of [
        "maxWriterIterPerSubtask",
        "maxPlannerRerunsPerSpec",
        "maxRetriesPerTransientFailure"
      ] as const) {
        const raw = form[field];
        if (raw !== undefined) {
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && parsed >= 0) next[field] = Math.floor(parsed);
        }
      }
      config.escapeHatches = next;
    });
    return c.redirect(`/settings/routing/${projectId}?saved=1`);
  });
}

/** Resolve a project's merged routing table + escape hatches, defaulted. */
function resolveConfig(config: ProjectConfig | undefined): {
  routing: RoutingTable;
  escapeHatches: EscapeHatches;
} {
  const routing = emptyRoutingTable();
  if (config?.routing !== undefined) {
    for (const role of ROLE_IDS) {
      const chain = config.routing[role]?.chain;
      if (Array.isArray(chain)) routing[role].chain = chain;
    }
  }
  const escapeHatches: EscapeHatches = {
    ...ESCAPE_HATCH_DEFAULTS,
    ...config?.escapeHatches
  };
  return { routing, escapeHatches };
}

function emptyRoutingTable(): RoutingTable {
  return {
    plan: { chain: [] },
    write: { chain: [] },
    check: { chain: [] },
    audit: { chain: [] },
    demo: { chain: [] },
    forge: { chain: [] }
  };
}

/**
 * Load the merged config, apply `edit` to a working copy, PATCH it back. The
 * working copy is built from a defaulted routing table + escape hatches so the
 * PATCH always sends a complete, schema-valid config (P2A-0006 / P2A-0013).
 */
async function mutateConfig(
  c: Context,
  deps: ShellDeps,
  orgId: string,
  projectId: string,
  edit: (config: ProjectConfig) => void
): Promise<void> {
  if (orgId === "") return;
  const client = clientFor(c, deps);
  const detail = await client.getProject(orgId, projectId);
  const resolved = resolveConfig(detail?.config);
  const working: ProjectConfig = {
    ...(detail?.config ?? { version: 1, routing: resolved.routing, escapeHatches: resolved.escapeHatches }),
    version: 1,
    routing: resolved.routing,
    escapeHatches: resolved.escapeHatches
  };
  edit(working);
  await client.patchProjectConfig(orgId, projectId, working);
}

/** Re-render the spec form (shared by the create-spec validation/error path). */
async function renderForm(
  c: Context,
  ctx: Awaited<ReturnType<typeof loadShellContext>>,
  deps: ShellDeps,
  projectId: string,
  error: string,
  values: { title: string; description: string; acceptanceCriteria: string[]; milestoneId: string }
) {
  if (ctx.org === undefined || ctx.project === undefined) {
    return renderShell(c, ctx, { title: "tanren · new spec" }, notFoundBody(projectId));
  }
  const client = clientFor(c, deps);
  const [milestones, behaviors, specs] = await Promise.all([
    client.listMilestones(ctx.org.id, projectId),
    client.listAllBehaviors(ctx.org.id, projectId),
    client.listSpecs(ctx.org.id, projectId)
  ]);
  return renderShell(
    c,
    ctx,
    { title: "tanren · new spec" },
    <SpecCreateBody project={ctx.project} milestones={milestones} behaviors={behaviors} specs={specs} error={error} values={values} />
  );
}
