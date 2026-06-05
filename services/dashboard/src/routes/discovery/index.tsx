/**
 * spec-discovery mount, registered through the append-only screen
 * registry. Composes the Forge classification (the classification runs over the same
 * answerer seam, here via the orchestrator discovery route) and the project-DAG read (the
 * accepted specs land as DAG nodes; the success banner links into the DAG).
 *
 * Routes registered:
 *   GET  /discovery                              project chooser → variant entry
 *   GET  /projects/:projectId/discovery          insight form (+ ?variant)
 *   POST /projects/:projectId/discovery          classify → re-render with result
 *   POST /projects/:projectId/discovery/accept   create specs + provenance + place
 *
 * The discovery client is its OWN api module (`api/discoveryClient.ts`) per the
 * screen-isolation lesson; the route instantiates it with the forwarded cookie.
 */

import type { Context, Hono } from "hono";
import { DiscoveryClient } from "../../api/discoveryClient.js";
import type { DiscoveryInsight, PlacementKind, ProposedSpec } from "../../api/discoveryTypes.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { DiscoveryBody } from "../../components/discovery/DiscoveryBody.js";
import { isVariant, SEED_INSIGHTS } from "../../components/discovery/seeds.js";

function clientFor(c: Context, deps: ShellDeps): DiscoveryClient {
  return new DiscoveryClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

function resolveVariant(raw: string | undefined): DiscoveryInsight["variant"] {
  return raw !== undefined && isVariant(raw) ? raw : "feature";
}

function notFound(projectId: string) {
  return (
    <div class="p2b">
      <div class="page-head">
        <div>
          <div class="eyebrow">discover spec · not found</div>
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

export function mountDiscoveryScreens(app: Hono, deps: ShellDeps): void {
  // Entry chooser: discovery is per-project. Redirect to the first project's
  // discovery surface, or render a prompt to link a project first.
  app.get("/discovery", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "discovery" });
    const project = ctx.projects[0];
    if (ctx.org === undefined || project === undefined) {
      return renderShell(
        c,
        ctx,
        { title: "tanren · discover spec" },
        <div class="p2b">
          <div class="page-head">
            <div>
              <div class="eyebrow">▮ spec discovery</div>
              <div class="page-title">no project yet</div>
            </div>
          </div>
          <div class="page-body">
            <section class="placeholder-card">
              <p>
                Discovery is per-project — classify an insight against a live DAG.{" "}
                <a href="/onboarding/existing">link a repo ↗</a>
              </p>
            </section>
          </div>
        </div>,
      );
    }
    return c.redirect(`/projects/${project.projectId}/discovery`);
  });

  // Insight form (GET). Pre-fills the variant's seed insight.
  app.get("/projects/:projectId/discovery", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "discovery", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · discover spec" }, notFound(projectId));
    }
    const variant = resolveVariant(c.req.query("variant"));
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${ctx.project.name} · discover` },
      <DiscoveryBody project={ctx.project} orgId={ctx.org.id} variant={variant} insight={SEED_INSIGHTS[variant]} />,
    );
  });

  // Classify (POST). Builds the insight from the submitted fields, runs the
  // orchestrator classification, and re-renders with the result.
  app.post("/projects/:projectId/discovery", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "discovery", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · discover spec" }, notFound(projectId));
    }
    const form = await c.req.parseBody();
    const variant = resolveVariant(String(form["variant"] ?? ""));
    const seed = SEED_INSIGHTS[variant];
    const insight: DiscoveryInsight = {
      variant,
      source: String(form["source"] ?? seed.source) || seed.source,
      sourceLabel: String(form["sourceLabel"] ?? seed.sourceLabel) || seed.sourceLabel,
      who: String(form["who"] ?? seed.who) || seed.who,
      when: String(form["when"] ?? seed.when) || seed.when,
      glyph: String(form["glyph"] ?? seed.glyph) || seed.glyph,
      body: String(form["body"] ?? seed.body).trim() || seed.body,
    };
    const client = clientFor(c, deps);
    const { result } = await client.classify(ctx.org.id, projectId, insight);
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${ctx.project.name} · discover` },
      <DiscoveryBody
        project={ctx.project}
        orgId={ctx.org.id}
        variant={variant}
        insight={insight}
        result={result}
        error={result === undefined ? "forge classification failed — try again." : undefined}
      />,
    );
  });

  // Accept (POST). Creates the accepted specs + provenance at the chosen
  // placement, then re-renders the form with a success banner.
  app.post("/projects/:projectId/discovery/accept", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "discovery", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · discover spec" }, notFound(projectId));
    }
    const form = await c.req.parseBody();
    const variant = resolveVariant(String(form["variant"] ?? ""));
    const insight = safeJson<DiscoveryInsight>(String(form["insight"] ?? ""));
    const proposals = safeJson<ProposedSpec[]>(String(form["proposals"] ?? "")) ?? [];
    const placementKind = String(form["placementKind"] ?? "slot_after") as PlacementKind;
    const placementLabel = String(form["placementLabel"] ?? "").trim();

    const reRender = (error: string) =>
      renderShell(
        c,
        ctx,
        { title: `tanren · ${ctx.project!.name} · discover` },
        <DiscoveryBody
          project={ctx.project!}
          orgId={ctx.org!.id}
          variant={variant}
          insight={insight ?? SEED_INSIGHTS[variant]}
          error={error}
        />,
      );

    if (insight === undefined || proposals.length === 0 || placementLabel === "") {
      return reRender("could not read the accepted proposals — re-classify and try again.");
    }

    const client = clientFor(c, deps);
    const { ok, result } = await client.accept(ctx.org.id, projectId, {
      insight,
      proposals,
      placementKind,
      placementLabel,
    });
    if (!ok || result === undefined) {
      return reRender("could not add the specs to the dag — try again.");
    }
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${ctx.project.name} · discover` },
      <DiscoveryBody
        project={ctx.project}
        orgId={ctx.org.id}
        variant={variant}
        insight={insight}
        accepted={{ count: result.accepted.length, placementLabel }}
      />,
    );
  });
}

function safeJson<T>(raw: string): T | undefined {
  if (raw === "") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
