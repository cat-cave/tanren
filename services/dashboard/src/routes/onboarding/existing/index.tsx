/**
 * P3-0016 brownfield onboarding FULL track (`/onboarding/existing`) — the 5-step
 * flow that supersedes the P2B-0002 minimal link form: link repo → read-only
 * recon → config-injection PR → DAG seed → governance posture.
 *
 * Owns the brownfield `existing` handlers entirely (the shared
 * `routes/onboarding/index.tsx` delegates here via `mountExistingBrownfield`, so
 * the org/credentials/notifications handlers there are untouched, and the
 * greenfield `new` flow is never touched). Composes:
 *   - P2B-0002 minimal link: step 1 reuses the existing create-project +
 *     brownfield-link POST, then advances into recon.
 *   - P3-0016 brownfield engine (orchestrator): recon / config-injection /
 *     seed-dag / governance, all behind the injectable `ExistingBrownfieldClient`.
 *
 * State model (no migration, no session table): the recon report + repoUrl +
 * projectId ride forward on hidden form fields step-to-step (the greenfield
 * pattern). Pause/resume = leave + return to the same step with the same state.
 */

import type { Context, Hono } from "hono";
import { ExistingBrownfieldClient } from "../../../api/existingBrownfieldClient.js";
import type { GovernancePosture, ReconReport } from "../../../api/existingBrownfieldTypes.js";
import { OrchestratorClient } from "../../../api/orchestrator.js";
import type { BrownfieldDetectedFile } from "../../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../../app/mountShell.js";
import type { ShellContext } from "../../../app/shell.js";
import { ExistingFullBody } from "../../../components/onboarding/existing/ExistingFullBody.js";

const GITHUB_APP_URL = process.env["TANREN_GITHUB_APP_URL"] ?? "https://github.com/apps/tanren/installations/new";

function brownfieldClient(c: Context, deps: ShellDeps): ExistingBrownfieldClient {
  return new ExistingBrownfieldClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

function orchestratorClient(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

function parseReport(raw: unknown): ReconReport | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    return JSON.parse(raw) as ReconReport;
  } catch {
    return undefined;
  }
}

function render(c: Context, ctx: ShellContext, body: unknown) {
  return renderShell(c, ctx, { title: "tanren · link existing project" }, body);
}

export function mountExistingBrownfield(app: Hono, deps: ShellDeps): void {
  // Step 1 entry (GET): the minimal link form (reused) inside the full shell.
  app.get("/onboarding/existing", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "onb-exist" });
    return render(
      c,
      ctx,
      <ExistingFullBody step={1} orgLogin={ctx.org?.login ?? "your org"} githubAppUrl={GITHUB_APP_URL} />,
    );
  });

  // Step 1 → 2 link POST. The reused P2B-0002 `ExistingProjectBody` form posts
  // here (its action is `/onboarding/existing/link`); we create + link the
  // project, run recon, and advance into step 2.
  app.post("/onboarding/existing/link", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "onb-exist" });
    const form = await c.req.parseBody();
    return handleLink(c, ctx, deps, form);
  });

  // POST: drives the active phase across steps 2-5.
  app.post("/onboarding/existing", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "onb-exist" });
    const form = await c.req.parseBody();
    const phase = String(form["phase"] ?? "advance");
    if (phase === "link") return handleLink(c, ctx, deps, form);
    if (phase === "advance") return handleAdvance(c, ctx, deps, form);
    if (phase === "open-pr") return handleOpenPr(c, ctx, deps, form);
    if (phase === "seed") return handleSeed(c, ctx, deps, form);
    if (phase === "governance") return handleGovernance(c, ctx, deps, form);
    return render(
      c,
      ctx,
      <ExistingFullBody step={1} orgLogin={ctx.org?.login ?? "your org"} githubAppUrl={GITHUB_APP_URL} />,
    );
  });
}

// Step 1 → 2: create the project, brownfield-link it, then run recon.
async function handleLink(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgLogin = ctx.org?.login ?? "your org";
  const orgId = ctx.org?.id;
  const repoUrl = String(form["repoUrl"] ?? "").trim();
  const name = String(form["name"] ?? "").trim() || repoUrl.split("/").pop() || "linked-project";
  const linkError = (error: string, linked?: { repoUrl: string; files: BrownfieldDetectedFile[]; projectId: string }) =>
    render(
      c,
      ctx,
      <ExistingFullBody step={1} orgLogin={orgLogin} githubAppUrl={GITHUB_APP_URL} link={{ error, linked }} />,
    );

  if (orgId === undefined || repoUrl === "") return linkError("pick a repo first");
  const product = orchestratorClient(c, deps);
  const project = await product.createProject(orgId, {
    name,
    repoUrl,
    defaultBranch: String(form["defaultBranch"] ?? "main"),
    allocator: String(form["allocator"] ?? "local_docker"),
    runnerImage: String(form["runnerImage"] ?? "tanren-runner"),
  });
  if (project === undefined) return linkError("project create failed");
  const link = await product.brownfieldLink(orgId, project.projectId, { repoUrl });
  if (!link.ok || link.result === undefined) {
    return linkError(link.error ?? "link failed (is the repo reachable by the GitHub App?)");
  }
  // Kick off recon now so step 2 has the chapters.
  const recon = await brownfieldClient(c, deps).recon(orgId, project.projectId, repoUrl);
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
      githubAppUrl={GITHUB_APP_URL}
      projectId={project.projectId}
      repoUrl={repoUrl}
      recon={recon.result}
      report={recon.result.report}
    />,
  );
}

// Generic step advance (2→3, 3→4, 4→5): re-render the next step with the report.
async function handleAdvance(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgLogin = ctx.org?.login ?? "your org";
  const step = Number.parseInt(String(form["step"] ?? "2"), 10) || 2;
  const repoUrl = String(form["repoUrl"] ?? "");
  const report = parseReport(form["report"]);
  const projectId = projectIdFromForm(form, ctx);
  const next = Math.min(5, step + 1) as 2 | 3 | 4 | 5;
  return render(
    c,
    ctx,
    <ExistingFullBody
      step={next}
      orgLogin={orgLogin}
      githubAppUrl={GITHUB_APP_URL}
      projectId={projectId}
      repoUrl={repoUrl}
      report={report}
    />,
  );
}

// Step 3: open the config-injection PR with the kept (non-excluded) files.
async function handleOpenPr(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgLogin = ctx.org?.login ?? "your org";
  const orgId = ctx.org?.id;
  const repoUrl = String(form["repoUrl"] ?? "");
  const report = parseReport(form["report"]);
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
        githubAppUrl={GITHUB_APP_URL}
        projectId={projectId}
        repoUrl={repoUrl}
        report={report}
        posture={posture}
        {...extra}
      />,
    );

  if (orgId === undefined || projectId === undefined || report === undefined) {
    return baseStep3({ configInjectionError: "lost the recon report — restart from step 1." });
  }
  const excludePaths = ALL_PROPOSED_PATHS.filter((p) => !kept.includes(p));
  const result = await brownfieldClient(c, deps).configInjection(orgId, projectId, {
    repoUrl,
    baseBranch: "main",
    report,
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
  const repoUrl = String(form["repoUrl"] ?? "");
  const report = parseReport(form["report"]);
  const projectId = projectIdFromForm(form, ctx);
  if (orgId === undefined || projectId === undefined || report === undefined) {
    return render(
      c,
      ctx,
      <ExistingFullBody
        step={1}
        orgLogin={orgLogin}
        githubAppUrl={GITHUB_APP_URL}
        link={{ error: "lost the recon report — restart." }}
      />,
    );
  }
  const result = await brownfieldClient(c, deps).seedDag(orgId, projectId, {
    repoUrl,
    report,
    includeIssues: true,
  });
  return render(
    c,
    ctx,
    <ExistingFullBody
      step={4}
      orgLogin={orgLogin}
      githubAppUrl={GITHUB_APP_URL}
      projectId={projectId}
      repoUrl={repoUrl}
      report={report}
      seeded={result.result}
    />,
  );
}

// Step 5: persist the chosen governance posture.
async function handleGovernance(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgLogin = ctx.org?.login ?? "your org";
  const orgId = ctx.org?.id;
  const repoUrl = String(form["repoUrl"] ?? "");
  const posture = postureFromForm(form);
  const projectId = projectIdFromForm(form, ctx);
  const saved =
    orgId !== undefined && projectId !== undefined
      ? (await brownfieldClient(c, deps).governance(orgId, projectId, posture)).result
      : undefined;
  return render(
    c,
    ctx,
    <ExistingFullBody
      step={5}
      orgLogin={orgLogin}
      githubAppUrl={GITHUB_APP_URL}
      projectId={projectId}
      repoUrl={repoUrl}
      posture={posture}
      governance={saved}
    />,
  );
}

// The 5 proposed file paths (mirror the orchestrator `proposeConfigFiles`).
const ALL_PROPOSED_PATHS = [
  ".tanren/PROJECT.md",
  ".github/workflows/tanren-ci.yml",
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
  const value = String(form["posture"] ?? "strict");
  return value === "open" || value === "audit_only" ? value : "strict";
}

// The projectId rides forward on a hidden field once linked. We also fall back
// to the only project on the shell context when present (single-project case).
function projectIdFromForm(form: Record<string, unknown>, ctx: ShellContext): string | undefined {
  const fromForm = String(form["projectId"] ?? "");
  if (fromForm !== "") return fromForm;
  return ctx.projects.length === 1 ? ctx.projects[0]?.projectId : undefined;
}
