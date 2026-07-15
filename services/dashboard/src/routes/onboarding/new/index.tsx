/**
 * greenfield onboarding (`/onboarding/new`) — the FULL track that
 * supersedes the thin form: multi-round Forge vision interview → derived spec
 * DAG → arrival. Registered through the append-only screen registry (its own
 * mount fn), so it does NOT edit the SHARED `routes/onboarding/index.tsx`
 * brownfield handler — it owns its routes entirely under `routes/onboarding/new`.
 *
 * Composes:
 *   - answerer seam: each interview round runs over the orchestrator's
 *     injectable interview answerer (deterministic fallback live by default).
 *   - on completion the capture DERIVES a real project's
 *     personas/behaviors/milestones/specs (orchestrator `…/interview/derive`).
 *   -: step 2 renders the just-derived graph via `getProjectDag` +
 *     `DagCanvas` — the DAG is live, not a mock.
 *
 * State model (no migration, no session table): the running capture rides on a
 * hidden form field round-to-round; once derived, the projectId rides forward.
 * Pause/resume = leave + return to the same step with the same hidden state.
 *
 * Routes:
 *   GET  /onboarding/new                 step 1 opening round (or ?step / ?projectId)
 *   POST /onboarding/new?step=1          run one interview round (phase=round)
 *   POST /onboarding/new?step=2          derive the graph + render the DAG (advance)
 *   POST /onboarding/new?step=3          render the arrival card (advance)
 */

import type { Context, Hono } from "hono";
import { clientDepsFor } from "../../../api/clientDeps.js";
import { formField } from "../../formField.js";
import { OnboardingNewClient } from "../../../api/onboardingNewClient.js";
import { OrchestratorClient } from "../../../api/orchestrator.js";
import { emptyCapture, type InterviewCapture } from "../../../api/onboardingNewTypes.js";
import { getProjectDag, ProjectDagUnavailableError, type ProjectDag } from "../../../api/projectDag.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../../app/mountShell.js";
import type { ShellContext } from "../../../app/shell.js";
import { GreenfieldBody } from "../../../components/onboarding/new/GreenfieldBody.js";

/** Interview/derive POSTs always carry session CSRF when present. */
async function writeNewClient(c: Context, deps: ShellDeps): Promise<OnboardingNewClient> {
  return new OnboardingNewClient(await clientDepsFor(c, deps));
}

function orchestratorClient(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

function parseCapture(raw: unknown): InterviewCapture {
  if (typeof raw !== "string" || raw === "") return emptyCapture();
  try {
    return { ...emptyCapture(), ...(JSON.parse(raw) as Partial<InterviewCapture>) };
  } catch {
    return emptyCapture();
  }
}

function noOrgBody(error?: string, csrfToken?: string) {
  return (
    <GreenfieldBody
      step={1}
      interview={{
        round: 1,
        totalRounds: 14,
        say: "Link an org first — the greenfield flow derives into a project under your org.",
        suggestions: [],
        priorAnswer: "",
        capture: emptyCapture(),
        complete: false,
      }}
      error={error ?? "no org yet — finish org setup, then start a new project."}
      csrfToken={csrfToken}
    />
  );
}

export function mountGreenfieldOnboarding(app: Hono, deps: ShellDeps): void {
  // Step 1 entry (GET): the opening interview round.
  app.get("/onboarding/new", async (c) => {
    const ctx = await loadShellContext(c, deps, {});
    if (ctx.org === undefined) {
      return renderShell(c, ctx, { title: "tanren · new project" }, noOrgBody(undefined, ctx.csrfToken));
    }
    const step = Number.parseInt(c.req.query("step") ?? "1", 10) || 1;
    const projectId = c.req.query("projectId");
    if (step >= 2 && projectId !== undefined && projectId !== "") {
      return renderDerivedStep(c, ctx, deps, step >= 3 ? 3 : 2, projectId);
    }
    // Fresh round 1 (orchestrator interview is a POST — carry CSRF).
    const { ok, result } = await (
      await writeNewClient(c, deps)
    ).round(ctx.org.id, {
      round: 1,
      answer: "",
      capture: emptyCapture(),
    });
    return renderShell(
      c,
      ctx,
      { title: "tanren · new project" },
      <GreenfieldBody
        step={1}
        interview={{
          round: result?.round ?? 1,
          totalRounds: result?.totalRounds ?? 14,
          say: result?.say ?? "What are we building, and who is it for?",
          suggestions: result?.suggestions ?? [],
          priorAnswer: "",
          capture: result?.capture ?? emptyCapture(),
          complete: result?.complete ?? false,
        }}
        error={!ok || result === undefined ? "forge is unreachable — try again." : undefined}
        csrfToken={ctx.csrfToken}
      />,
    );
  });

  // POST: drives the active phase (round / advance-to-derive / advance-to-arrival).
  app.post("/onboarding/new", async (c) => {
    const ctx = await loadShellContext(c, deps, {});
    if (ctx.org === undefined) {
      return renderShell(c, ctx, { title: "tanren · new project" }, noOrgBody(undefined, ctx.csrfToken));
    }
    const form = await c.req.parseBody();
    const phase = formField(form, "phase", "round");
    const step = Number.parseInt(c.req.query("step") ?? "1", 10) || 1;

    if (phase === "round") {
      return handleRound(c, ctx, deps, form);
    }
    if (step === 2) {
      return handleDerive(c, ctx, deps, parseCapture(form["capture"]));
    }
    // step 3 advance: the projectId rode forward on the derived-summary form.
    const projectId = formField(form, "projectId");
    if (projectId === "") {
      return renderShell(
        c,
        ctx,
        { title: "tanren · new project" },
        noOrgBody("lost the derived project — restart the interview.", ctx.csrfToken),
      );
    }
    return renderDerivedStep(c, ctx, deps, 3, projectId);
  });
}

async function handleRound(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgId = ctx.org!.id;
  const round = Number.parseInt(formField(form, "round", "1"), 10) || 1;
  const answer = formField(form, "answer");
  const capture = parseCapture(form["capture"]);
  const { ok, result } = await (await writeNewClient(c, deps)).round(orgId, { round, answer, capture });
  return renderShell(
    c,
    ctx,
    { title: "tanren · new project" },
    <GreenfieldBody
      step={1}
      interview={{
        round: result?.round ?? round,
        totalRounds: result?.totalRounds ?? 14,
        say: result?.say ?? "tell me more.",
        suggestions: result?.suggestions ?? [],
        priorAnswer: answer,
        capture: result?.capture ?? capture,
        complete: result?.complete ?? false,
      }}
      error={!ok || result === undefined ? "forge is unreachable — your answer was kept; try again." : undefined}
      csrfToken={ctx.csrfToken}
    />,
  );
}

async function handleDerive(c: Context, ctx: ShellContext, deps: ShellDeps, capture: InterviewCapture) {
  const orgId = ctx.org!.id;
  // The orchestrator's greenfield contract creates a real repository under the
  // authenticated Tanren/GitHub organization. The shell's resolved org login is
  // the authority; operators never supply a repo URL or an arbitrary owner.
  const { ok, result } = await (
    await writeNewClient(c, deps)
  ).derive(orgId, {
    capture,
    owner: ctx.org!.login,
  });
  if (!ok || result === undefined) {
    // Re-render step 1's completed state so the operator can retry the derive.
    return renderShell(
      c,
      ctx,
      { title: "tanren · new project" },
      <GreenfieldBody
        step={1}
        interview={{
          round: 14,
          totalRounds: 14,
          say: "Derive failed — try again.",
          suggestions: [],
          priorAnswer: "",
          capture,
          complete: true,
        }}
        error="could not derive the spec dag — try again."
        csrfToken={ctx.csrfToken}
      />,
    );
  }
  return renderDerivedStep(c, ctx, deps, 2, result.projectId, result.projectName);
}

// Fetch the live derived DAG for the project and render step 2 or 3.
async function renderDerivedStep(
  c: Context,
  ctx: ShellContext,
  deps: ShellDeps,
  step: 2 | 3,
  projectId: string,
  projectName?: string,
) {
  const orgId = ctx.org!.id;
  const dag = await loadDag(c, deps, orgId, projectId);
  const name =
    projectName ??
    ctx.projects.find((p: { projectId: string; name: string }) => p.projectId === projectId)?.name ??
    "your project";
  return renderShell(
    c,
    ctx,
    { title: "tanren · new project" },
    <GreenfieldBody step={step} derived={{ projectId, projectName: name, dag }} csrfToken={ctx.csrfToken} />,
  );
}

async function loadDag(c: Context, deps: ShellDeps, orgId: string, projectId: string): Promise<ProjectDag | undefined> {
  try {
    return await getProjectDag(orchestratorClient(c, deps), orgId, projectId);
  } catch (error) {
    if (error instanceof ProjectDagUnavailableError) return undefined;
    throw error;
  }
}
