/**
 * brownfield onboarding FULL track (`/onboarding/existing`) — the 5-step
 * flow that supersedes the minimal link form: link repo → read-only
 * recon → config-injection PR → DAG seed → governance posture.
 *
 * Owns the brownfield `existing` handlers entirely (the shared
 * `routes/onboarding/index.tsx` delegates here via `mountExistingBrownfield`, so
 * the org/credentials/notifications handlers there are untouched, and the
 * greenfield `new` flow is never touched). Composes:
 *   - minimal link: step 1 reuses the existing create-project +
 *     brownfield-link POST, then advances into recon.
 *   - brownfield engine (orchestrator): recon / config-injection /
 *     seed-dag / governance, all behind the injectable `ExistingBrownfieldClient`.
 *
 * State model (no migration, no session table): the recon report + repoUrl +
 * projectId ride forward on hidden form fields step-to-step (the greenfield
 * pattern). Pause/resume = leave + return to the same step with the same state.
 */

import type { Context, Hono } from "hono";
import { clientDepsFor } from "../../../api/clientDeps.js";
import { formField } from "../../formField.js";
import { ExistingBrownfieldClient } from "../../../api/existingBrownfieldClient.js";
import { decodeReconStateForDisplay, type GovernancePosture } from "../../../api/existingBrownfieldTypes.js";
import { OrchestratorClient } from "../../../api/orchestrator.js";
import type { BrownfieldDetectedFile } from "../../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../../app/mountShell.js";
import type { ShellContext } from "../../../app/shell.js";
import { ExistingFullBody } from "../../../components/onboarding/existing/ExistingFullBody.js";

/**
 * The CANONICAL GitHub App install URL env name (`TANREN_GITHUB_APP_INSTALL_URL`,
 * shared with the orchestrator; the old `TANREN_GITHUB_APP_URL` name is deleted).
 * LOCAL FALLBACK only — the dashboard prefers the value the orchestrator publishes
 * on `/auth/providers` (one source of truth); see `resolveGithubAppUrl`.
 */
const GITHUB_APP_URL_FALLBACK =
  process.env["TANREN_GITHUB_APP_INSTALL_URL"] ?? "https://github.com/apps/tanren/installations/new";

/** Read-only product client (no CSRF — GETs only). */
function orchestratorClient(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

/** Write clients always resolve session CSRF (local-dev actor omits it). */
async function writeBrownfieldClient(c: Context, deps: ShellDeps): Promise<ExistingBrownfieldClient> {
  return new ExistingBrownfieldClient(await clientDepsFor(c, deps));
}

async function writeOrchestratorClient(c: Context, deps: ShellDeps): Promise<OrchestratorClient> {
  return new OrchestratorClient(await clientDepsFor(c, deps));
}

/** Prefer the orchestrator-published App install URL over the local env fallback. */
async function resolveGithubAppUrl(c: Context, deps: ShellDeps): Promise<string> {
  return (await orchestratorClient(c, deps).authGithubAppInstallUrl()) ?? GITHUB_APP_URL_FALLBACK;
}

function render(c: Context, ctx: ShellContext, body: unknown) {
  return renderShell(c, ctx, { title: "tanren · link existing project" }, body);
}

export function mountExistingBrownfield(app: Hono, deps: ShellDeps): void {
  // Step 1 entry (GET): the minimal link form (reused) inside the full shell.
  app.get("/onboarding/existing", async (c) => {
    const ctx = await loadShellContext(c, deps, {});
    const githubAppUrl = await resolveGithubAppUrl(c, deps);
    return render(
      c,
      ctx,
      <ExistingFullBody
        step={1}
        orgLogin={ctx.org?.login ?? "your org"}
        githubAppUrl={githubAppUrl}
        csrfToken={ctx.csrfToken}
      />,
    );
  });

  // Step 1 → 2 link POST. The reused `ExistingProjectBody` form posts
  // here (its action is `/onboarding/existing/link`); we create + link the
  // project, run recon, and advance into step 2.
  app.post("/onboarding/existing/link", async (c) => {
    const ctx = await loadShellContext(c, deps, {});
    const form = await c.req.parseBody();
    return handleLink(c, ctx, deps, form);
  });

  // POST: drives the active phase across steps 2-5.
  app.post("/onboarding/existing", async (c) => {
    const ctx = await loadShellContext(c, deps, {});
    const form = await c.req.parseBody();
    const phase = formField(form, "phase", "advance");
    if (phase === "link") return handleLink(c, ctx, deps, form);
    if (phase === "advance") return handleAdvance(c, ctx, deps, form);
    if (phase === "open-pr") return handleOpenPr(c, ctx, deps, form);
    if (phase === "seed") return handleSeed(c, ctx, deps, form);
    if (phase === "governance") return handleGovernance(c, ctx, deps, form);
    const githubAppUrl = await resolveGithubAppUrl(c, deps);
    return render(
      c,
      ctx,
      <ExistingFullBody
        step={1}
        orgLogin={ctx.org?.login ?? "your org"}
        githubAppUrl={githubAppUrl}
        csrfToken={ctx.csrfToken}
      />,
    );
  });
}

// Step 1 → 2: create the project, brownfield-link it, then run recon.
async function handleLink(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgLogin = ctx.org?.login ?? "your org";
  const orgId = ctx.org?.id;
  const githubAppUrl = await resolveGithubAppUrl(c, deps);
  const repoUrl = formField(form, "repoUrl").trim();
  const name = formField(form, "name").trim() || repoUrl.split("/").pop() || "linked-project";
  const linkError = (error: string, linked?: { repoUrl: string; files: BrownfieldDetectedFile[]; projectId: string }) =>
    render(
      c,
      ctx,
      <ExistingFullBody
        step={1}
        orgLogin={orgLogin}
        githubAppUrl={githubAppUrl}
        link={{ error, linked }}
        csrfToken={ctx.csrfToken}
      />,
    );

  if (orgId === undefined || repoUrl === "") return linkError("pick a repo first");
  const product = await writeOrchestratorClient(c, deps);
  const project = await product.createProject(orgId, {
    name,
    repoUrl,
    defaultBranch: formField(form, "defaultBranch", "main"),
    allocator: formField(form, "allocator", "local_docker"),
    runnerImage: formField(form, "runnerImage", "tanren-runner"),
  });
  if (project === undefined) return linkError("project create failed");
  const link = await product.brownfieldLink(orgId, project.projectId, { repoUrl });
  if (!link.ok || link.result === undefined) {
    return linkError(link.error ?? "link failed (is the repo reachable by the GitHub App?)");
  }
  // Kick off recon now so step 2 has the chapters.
  const recon = await (await writeBrownfieldClient(c, deps)).recon(orgId, project.projectId, repoUrl);
  if (!recon.ok || recon.result === undefined) {
    // Recon failed — show the linked confirmation so the operator can retry.
    return linkError("linked, but recon could not read the repo — retry from the link step.", {
      repoUrl,
      files: link.result.detectedFiles,
      projectId: project.projectId,
    });
  }
  return render(
    c,
    ctx,
    <ExistingFullBody
      step={2}
      orgLogin={orgLogin}
      githubAppUrl={githubAppUrl}
      projectId={project.projectId}
      repoUrl={repoUrl}
      recon={recon.result}
      report={recon.result.report}
      state={recon.result.state}
      csrfToken={ctx.csrfToken}
    />,
  );
}

// Generic step advance (2→3, 3→4, 4→5): re-render the next step with the report.
async function handleAdvance(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgLogin = ctx.org?.login ?? "your org";
  const githubAppUrl = await resolveGithubAppUrl(c, deps);
  const step = Number.parseInt(formField(form, "step", "2"), 10) || 2;
  const state = formField(form, "state");
  const decoded = decodeReconStateForDisplay(state);
  const repoUrl = decoded?.repoUrl ?? "";
  const report = decoded?.report;
  const projectId = projectIdFromForm(form, ctx);
  const next = Math.min(5, step + 1) as 2 | 3 | 4 | 5;
  return render(
    c,
    ctx,
    <ExistingFullBody
      step={next}
      orgLogin={orgLogin}
      githubAppUrl={githubAppUrl}
      projectId={projectId}
      repoUrl={repoUrl}
      report={report}
      state={state}
      csrfToken={ctx.csrfToken}
    />,
  );
}

// Step 3: open the config-injection PR with the kept (non-excluded) files.
async function handleOpenPr(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgLogin = ctx.org?.login ?? "your org";
  const orgId = ctx.org?.id;
  const githubAppUrl = await resolveGithubAppUrl(c, deps);
  const state = formField(form, "state");
  const decoded = decodeReconStateForDisplay(state);
  const repoUrl = decoded?.repoUrl ?? "";
  const report = decoded?.report;
  const posture = postureFromForm(form);
  const projectId = projectIdFromForm(form, ctx);
  const kept = keepPathsFromForm(form);
  const baseStep3 = (extra: Record<string, unknown>) =>
    render(
      c,
      ctx,
      <ExistingFullBody
        step={3}
        orgLogin={orgLogin}
        githubAppUrl={githubAppUrl}
        projectId={projectId}
        repoUrl={repoUrl}
        report={report}
        state={state}
        posture={posture}
        csrfToken={ctx.csrfToken}
        {...extra}
      />,
    );

  if (orgId === undefined || projectId === undefined || report === undefined || state === "") {
    return baseStep3({ configInjectionError: "lost the recon report — restart from step 1." });
  }
  const excludePaths = ALL_PROPOSED_PATHS.filter((p) => !kept.includes(p));
  const result = await (
    await writeBrownfieldClient(c, deps)
  ).configInjection(orgId, projectId, {
    state,
    posture,
    excludePaths,
  });
  if (!result.ok || result.result === undefined) {
    return baseStep3({
      configInjectionError: result.error ?? "could not open the config-injection PR — try again.",
    });
  }
  return baseStep3({ configInjection: result.result });
}

// Step 4: seed the DAG from recon gaps + GitHub issues.
async function handleSeed(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgLogin = ctx.org?.login ?? "your org";
  const orgId = ctx.org?.id;
  const githubAppUrl = await resolveGithubAppUrl(c, deps);
  const state = formField(form, "state");
  const decoded = decodeReconStateForDisplay(state);
  const repoUrl = decoded?.repoUrl ?? "";
  const report = decoded?.report;
  const projectId = projectIdFromForm(form, ctx);
  if (orgId === undefined || projectId === undefined || report === undefined || state === "") {
    return render(
      c,
      ctx,
      <ExistingFullBody
        step={1}
        orgLogin={orgLogin}
        githubAppUrl={githubAppUrl}
        link={{ error: "lost the recon report — restart." }}
        csrfToken={ctx.csrfToken}
      />,
    );
  }
  const result = await (
    await writeBrownfieldClient(c, deps)
  ).seedDag(orgId, projectId, {
    state,
    includeIssues: true,
  });
  return render(
    c,
    ctx,
    <ExistingFullBody
      step={4}
      orgLogin={orgLogin}
      githubAppUrl={githubAppUrl}
      projectId={projectId}
      repoUrl={repoUrl}
      report={report}
      state={state}
      seeded={result.ok ? result.result : undefined}
      seedError={result.ok ? undefined : (result.error ?? "could not seed the spec dag — try again.")}
      csrfToken={ctx.csrfToken}
    />,
  );
}

// Step 5: persist the chosen governance posture.
async function handleGovernance(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgLogin = ctx.org?.login ?? "your org";
  const orgId = ctx.org?.id;
  const githubAppUrl = await resolveGithubAppUrl(c, deps);
  const repoUrl = formField(form, "repoUrl");
  const posture = postureFromForm(form);
  const projectId = projectIdFromForm(form, ctx);
  const saved =
    orgId !== undefined && projectId !== undefined
      ? (await (await writeBrownfieldClient(c, deps)).governance(orgId, projectId, posture)).result
      : undefined;
  return render(
    c,
    ctx,
    <ExistingFullBody
      step={5}
      orgLogin={orgLogin}
      githubAppUrl={githubAppUrl}
      projectId={projectId}
      repoUrl={repoUrl}
      posture={posture}
      governance={saved}
      csrfToken={ctx.csrfToken}
    />,
  );
}

// The 5 proposed file paths (mirror the orchestrator `proposeConfigFiles`).
const ALL_PROPOSED_PATHS = [
  ".tanren/PROJECT.md",
  ".tanren/ci.yml",
  "CODEOWNERS",
  ".gitignore",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

function keepPathsFromForm(form: Record<string, unknown>): string[] {
  const raw = form["keep"];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return [raw];
  return [];
}

function postureFromForm(form: Record<string, unknown>): GovernancePosture {
  const value = formField(form, "posture", "strict");
  return value === "open" || value === "audit_only" ? value : "strict";
}

// The projectId rides forward on a hidden field once linked. We also fall back
// to the only project on the shell context when present (single-project case).
function projectIdFromForm(form: Record<string, unknown>, ctx: ShellContext): string | undefined {
  const fromForm = formField(form, "projectId");
  if (fromForm !== "") return fromForm;
  return ctx.projects.length === 1 ? ctx.projects[0]?.projectId : undefined;
}
