/**
 * Shell mounting + the extension-point convention every child screen uses.
 *
 * `mountShell(app, deps)` registers the chrome routes on the Hono app:
 *   - one route per sidenav row (placeholders during 2B),
 *   - a project route `/projects/:projectId` that sets the project crumb.
 *
 * Child screens (P2B-0002…0009) "mount their route here" by calling
 * `renderShell(c, deps, { ... }, <PageBody/>)` from their own handler instead of
 * the placeholder. The contract:
 *   1. resolve the shell context with `loadShellContext` (org + projects +
 *      palette), passing the active nav id and project id;
 *   2. render their page body inside `ShellLayout` via `renderShell`.
 * They never touch TopBar/SideNav/ForgePalette or this file — they register
 * their own `app.get(...)` and reuse `renderShell`. See README in tests/e2e.
 */

import type { Context, Hono } from "hono";
import { buildPaletteGroups, OrchestratorClient } from "../api/orchestrator.js";
import type { OrgSummary, ProjectSummary } from "../api/types.js";
import { PlaceholderBody } from "./placeholder.js";
import { allNavRows, type NavRow } from "./routes.js";
import { ShellLayout, type ShellContext, type Surface } from "./shell.js";

export interface ShellDeps {
  orchestratorUrl: string;
}

/** Read the operator's preferred surface from the `tanren_surface` cookie. */
function surfaceFromCookie(cookieHeader: string | undefined): Surface {
  if (cookieHeader === undefined) return "ink";
  const match = /(?:^|;\s*)tanren_surface=(ink|ash)/.exec(cookieHeader);
  return match?.[1] === "ash" ? "ash" : "ink";
}

export interface LoadShellContextArgs {
  activeNavId?: string;
  /** Project id when the route is project-scoped (sets the crumb). */
  projectId?: string;
}

/**
 * Resolve the full shell context for a request: session-scoped org + project
 * lists from the orchestrator, the active project, and the templated palette.
 * Degrades to empty collections when unauthenticated so the chrome still
 * renders (dev / TANREN_REQUIRE_AUTH=0).
 */
export async function loadShellContext(
  c: Context,
  deps: ShellDeps,
  args: LoadShellContextArgs = {}
): Promise<ShellContext> {
  const client = new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie")
  });
  const orgs = await client.listOrgs();
  const org: OrgSummary | undefined = orgs[0];
  const projects: ProjectSummary[] = org ? await client.listProjects(org.id) : [];
  const project = args.projectId
    ? projects.find((p) => p.projectId === args.projectId)
    : undefined;
  return {
    org,
    projects,
    project,
    activeNavId: args.activeNavId,
    paletteGroups: buildPaletteGroups({ orgLogin: org?.login ?? "", projects }),
    surface: surfaceFromCookie(c.req.header("cookie")),
    operator: org?.login ?? "operator"
  };
}

/**
 * Render a page body inside the shell. The single entry point child screens use
 * so the chrome stays consistent and owned by P2B-0001.
 */
export function renderShell(
  c: Context,
  ctx: ShellContext,
  opts: { title: string },
  body: unknown
): Response | Promise<Response> {
  return c.html(
    <ShellLayout title={opts.title} ctx={ctx}>
      {body}
    </ShellLayout>
  );
}

/** Register a single placeholder route for a sidenav row. */
function mountPlaceholder(app: Hono, deps: ShellDeps, row: NavRow): void {
  // Skip project-scoped template paths — those are handled by the project route.
  if (row.path.includes(":projectId")) return;
  app.get(row.path, async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: row.id });
    return renderShell(c, ctx, { title: `tanren · ${row.label}` }, <PlaceholderBody row={row} />);
  });
}

/**
 * Mount the shell chrome routes. Call once during app construction, BEFORE
 * child-screen routers so a child can override a placeholder by registering the
 * same path later (Hono last-match-wins per method on identical paths is not
 * guaranteed; child specs own distinct subtrees, so collisions are by design
 * avoided — see the per-spec `Owns` map).
 */
export function mountShell(app: Hono, deps: ShellDeps): void {
  // Landing: redirect root to the project list (the operator home in 2B).
  app.get("/", (c) => c.redirect("/projects"));

  // Project list (placeholder until P2B-0003).
  app.get("/projects", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects" });
    return renderShell(
      c,
      ctx,
      { title: "tanren · projects" },
      <ProjectListBody ctx={ctx} />
    );
  });

  // Project-scoped landing: sets the crumb + switcher selection.
  app.get("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${ctx.project?.name ?? projectId}` },
      <ProjectPlaceholderBody projectId={projectId} found={ctx.project !== undefined} />
    );
  });

  for (const row of allNavRows()) {
    mountPlaceholder(app, deps, row);
  }
}

function ProjectListBody(props: { ctx: ShellContext }) {
  const { projects } = props.ctx;
  return (
    <>
      <div class="page-head">
        <div>
          <div class="eyebrow">org · {props.ctx.org?.login ?? "—"}</div>
          <div class="page-title">projects</div>
        </div>
      </div>
      <div class="page-body">
        {projects.length === 0 ? (
          <section class="placeholder-card">
            <p>No projects yet. Onboard one to start forging.</p>
            <p class="placeholder-note">
              <a href="/onboarding/existing">link an existing repo ↗</a> ·{" "}
              <a href="/onboarding/new">start a new project +</a>
            </p>
          </section>
        ) : (
          <section class="placeholder-card">
            <div class="project-rows">
              {projects.map((proj) => (
                <a class="project-row" href={`/projects/${proj.projectId}`}>
                  <span class="dot"></span>
                  <span class="t">{proj.name}</span>
                  <span class="d">{proj.repoUrl}</span>
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function ProjectPlaceholderBody(props: { projectId: string; found: boolean }) {
  return (
    <>
      <div class="page-head">
        <div>
          <div class="eyebrow">project · ships in Phase 2B</div>
          <div class="page-title">{props.found ? "project view" : "project not found"}</div>
          <div class="sub">owned by P2B-0003</div>
        </div>
      </div>
      <div class="page-body">
        <section class="placeholder-card">
          <p>
            {props.found
              ? "The chat-primary project view mounts here when P2B-0003 lands."
              : `No project ${props.projectId} is visible to you.`}
          </p>
        </section>
      </div>
    </>
  );
}
