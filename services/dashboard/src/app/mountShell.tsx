/**
 * Shell mounting + the extension-point convention every child screen uses.
 *
 * ## How child screens mount their routes — THE convention
 *
 * 1. **Add a mount function to the append-only screen registry** in
 *    `./screens.ts`: `SCREEN_MOUNTS.push(mountCostsScreen)`. Each entry is a
 *    `(app, deps) => void` that registers the spec's own routes under its owned
 *    `src/routes/<area>/**` subtree. The array is append-only so parallel
 *    fan-out PRs never conflict on it.
 * 2. **Render through the shell** with `renderShell(c, ctx, { title }, <Body/>)`:
 *    - resolve the shell context with `loadShellContext` (org + projects +
 *      palette), passing the active nav id and project id;
 *    - render the page body inside `ShellLayout` via `renderShell`.
 *    Child screens never touch TopBar/SideNav/ForgePalette or this file.
 *
 * ## Ordering contract (makes "real route always wins" order-robust)
 *
 * `createApp` runs the screen registry (`mountScreens`) BEFORE `mountShell`.
 * `mountShell` then registers placeholders ONLY for paths that have no GET
 * handler yet (it inspects `app.routes`). So a child route registered via the
 * registry is always present first and is never shadowed by a placeholder —
 * regardless of Hono's first-match-wins chain semantics. A child screen owning
 * a sidenav row simply registers its real GET at that row's `path` and the
 * placeholder is skipped automatically.
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../api/orchestrator.js";
import { buildPaletteGroups } from "../api/palette.js";
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
  const match = /(?:^|;\s*)tanren_surface=(ink|ash)/u.exec(cookieHeader);
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
  args: LoadShellContextArgs = {},
): Promise<ShellContext> {
  const cookieHeader = c.req.header("cookie");
  const client = new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader,
  });
  // Session CSRF is embedded in the shell so (1) client islands attach
  // x-csrf-token on same-origin forge POSTs and (2) server-rendered forms can
  // include a hidden csrf field. Inbound BFF verification compares that value
  // before clientDepsFor mints outbound orchestrator CSRF.
  const session = await client.session();
  const orgs = await client.listOrgs();
  const org: OrgSummary | undefined = orgs[0];
  const projects: ProjectSummary[] = org ? await client.listProjects(org.id) : [];
  const project = args.projectId ? projects.find((p) => p.projectId === args.projectId) : undefined;
  return {
    org,
    projects,
    project,
    activeNavId: args.activeNavId,
    paletteGroups: buildPaletteGroups({ orgLogin: org?.login ?? "", projects }),
    surface: surfaceFromCookie(cookieHeader),
    operator: org?.login ?? "operator",
    csrfToken: session?.csrfToken,
  };
}

/**
 * Render a page body inside the shell. The single entry point child screens use
 * so the chrome stays consistent and owned by.
 */
export function renderShell(
  c: Context,
  ctx: ShellContext,
  opts: { title: string },
  body: unknown,
): Response | Promise<Response> {
  return c.html(
    <ShellLayout title={opts.title} ctx={ctx}>
      {body}
    </ShellLayout>,
  );
}

/**
 * True when a GET handler is already registered for `path`. Hono exposes the
 * registered routes as `{ method, path, handler }[]`; a child screen route
 * mounted earlier (via the screen registry) makes the shell skip its placeholder.
 */
function hasGetRoute(app: Hono, path: string): boolean {
  return app.routes.some((route) => route.method === "GET" && route.path === path);
}

/**
 * Register a placeholder GET for a sidenav row, ONLY if no handler claims its
 * path yet. Project-scoped template paths are owned by the project route below.
 */
function mountPlaceholder(app: Hono, deps: ShellDeps, row: NavRow): void {
  if (row.path.includes(":projectId")) return;
  if (hasGetRoute(app, row.path)) return;
  app.get(row.path, async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: row.id });
    return renderShell(c, ctx, { title: `tanren · ${row.label}` }, <PlaceholderBody row={row} />);
  });
}

/**
 * Mount the shell chrome routes. Call once during app construction, AFTER the
 * screen registry (`mountScreens`). Every route here is gap-filling: it is
 * registered only when no child screen already claims that path, so a real
 * child route is never shadowed by the shell.
 */
export function mountShell(app: Hono, deps: ShellDeps): void {
  // Landing: redirect root to the project list (the operator home in 2B).
  if (!hasGetRoute(app, "/")) {
    app.get("/", (c) => c.redirect("/projects"));
  }

  // Project list (placeholder until).
  if (!hasGetRoute(app, "/projects")) {
    app.get("/projects", async (c) => {
      const ctx = await loadShellContext(c, deps, { activeNavId: "projects" });
      return renderShell(c, ctx, { title: "tanren · projects" }, <ProjectListBody ctx={ctx} />);
    });
  }

  // Project-scoped landing: sets the crumb + switcher selection.
  if (!hasGetRoute(app, "/projects/:projectId")) {
    app.get("/projects/:projectId", async (c) => {
      const projectId = c.req.param("projectId");
      const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
      return renderShell(
        c,
        ctx,
        { title: `tanren · ${ctx.project?.name ?? projectId}` },
        <ProjectPlaceholderBody projectId={projectId} found={ctx.project !== undefined} />,
      );
    });
  }

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
