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
 * signed, expiring state token round-to-round; once derived, the projectId rides forward.
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
import { IntegrationsClient } from "../../../api/integrationsClient.js";
import {
  decodeInterviewStateForDisplay,
  emptyCapture,
  type DeriveAutonomy,
  type DeriveDeployInput,
  type InterviewCapture,
} from "../../../api/onboardingNewTypes.js";
import type { DeployOption } from "../../../components/onboarding/new/InterviewStep.js";
import { getProjectDag, type ProjectDag } from "../../../api/projectDag.js";
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

/** The derive form's prefill + linked-deploy options, resolved per request. */
interface DerivePrep {
  ownerDefault: string;
  deployOptions: DeployOption[];
}

const SUPPORTED_DEPLOY_KINDS = new Set(["deploy.vercel", "deploy.flyio"]);

/**
 * Resolve the derive form's prefill: the GitHub `owner` defaults to the org
 * login (the account the App is installed on) and the deploy select is populated
 * from the org's LINKED deploy integrations (a grant carries both connection +
 * grant ids so the server's paired-field refinement is satisfied). Failure to
 * read integrations degrades to no options — deploy is optional, so the derive
 * still succeeds; it never blocks or fabricates a connection.
 */
async function buildDerivePrep(c: Context, ctx: ShellContext, deps: ShellDeps): Promise<DerivePrep> {
  const ownerDefault = ctx.org?.login ?? "";
  const client = new IntegrationsClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
  const list = ctx.org === undefined ? undefined : await client.list(ctx.org.id);
  const deployOptions: DeployOption[] = [];
  for (const grant of list?.integrations ?? []) {
    if (!SUPPORTED_DEPLOY_KINDS.has(grant.providerKind) || grant.grantId === undefined) continue;
    deployOptions.push({
      value: `${grant.providerKind}::${grant.connectionId}::${grant.grantId}`,
      label: `${grant.providerKind} · ${grant.displayName}`,
    });
  }
  return { ownerDefault, deployOptions };
}

/** Parse the derive form's `deploy` select value (`kind::connectionId::grantId`). */
function parseDeploy(raw: string): DeriveDeployInput | undefined {
  if (raw === "") return undefined;
  const [providerKind, connectionId, grantId] = raw.split("::");
  if (providerKind !== "deploy.vercel" && providerKind !== "deploy.flyio") return undefined;
  return {
    providerKind,
    ...(connectionId === undefined || connectionId === "" ? {} : { connectionId }),
    ...(grantId === undefined || grantId === "" ? {} : { grantId }),
  };
}

/** Parse the derive form's `autonomy` select value (defaults to `auto`). */
function parseAutonomy(raw: string): DeriveAutonomy {
  return raw === "simulated" || raw === "human" ? raw : "auto";
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
        state: "",
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
    const { result } = await (
      await writeNewClient(c, deps)
    ).round(ctx.org.id, {
      round: 1,
      answer: "",
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
          state: result?.state ?? "",
          complete: result?.complete ?? false,
        }}
        error={result === undefined ? "forge is unreachable — try again." : undefined}
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
      return handleDerive(c, ctx, deps, form);
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
  const state = formField(form, "state");
  const { result } = await (
    await writeNewClient(c, deps)
  ).round(orgId, {
    round,
    answer,
    ...(state === "" ? {} : { state }),
  });
  const complete = result?.complete ?? false;
  // Only pay for the integrations read once the interview is actually ready to
  // derive (that is the only render where the owner/deploy form is shown).
  const prep = complete ? await buildDerivePrep(c, ctx, deps) : undefined;
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
        capture: result?.capture ?? decodeInterviewStateForDisplay(state)?.capture ?? emptyCapture(),
        complete,
        state: result?.state ?? state,
        ...(prep === undefined ? {} : { ownerDefault: prep.ownerDefault, deployOptions: prep.deployOptions }),
      }}
      error={result === undefined ? "forge is unreachable — your answer was kept; try again." : undefined}
      csrfToken={ctx.csrfToken}
    />,
  );
}

async function handleDerive(c: Context, ctx: ShellContext, deps: ShellDeps, form: Record<string, unknown>) {
  const orgId = ctx.org!.id;
  const state = formField(form, "state");
  const capture = decodeInterviewStateForDisplay(state)?.capture ?? emptyCapture();
  const owner = formField(form, "owner").trim();
  const autonomy = parseAutonomy(formField(form, "autonomy"));
  const deploy = parseDeploy(formField(form, "deploy"));

  // FIELD-LEVEL VALIDATION: the orchestrator's strict `DeriveBody` REQUIRES a
  // non-empty `owner`. Guard it here so an omitted owner surfaces as an inline
  // form error on the completed interview step — never a raw 400 from a doomed
  // derive call.
  if (owner === "") {
    const prep = await buildDerivePrep(c, ctx, deps);
    return renderCompleteRetry(c, ctx, state, capture, {
      ownerError: "enter the github owner for the new repo before deriving.",
      ownerDefault: prep.ownerDefault,
      deployOptions: prep.deployOptions,
    });
  }

  const { ok, result } = await (
    await writeNewClient(c, deps)
  ).derive(orgId, {
    state,
    owner,
    autonomy,
    ...(deploy === undefined ? {} : { deploy }),
  });
  if (!ok || result === undefined) {
    // Re-render step 1's completed state so the operator can retry the derive,
    // preserving the owner/deploy they entered.
    const prep = await buildDerivePrep(c, ctx, deps);
    return renderCompleteRetry(c, ctx, state, capture, {
      error: "could not derive the spec dag — try again.",
      ownerDefault: owner === "" ? prep.ownerDefault : owner,
      deployOptions: prep.deployOptions,
    });
  }
  return renderDerivedStep(c, ctx, deps, 2, result.projectId, result.projectName);
}

// Re-render the completed interview step (the derive form) — the single retry
// surface for both a validation miss and a failed derive.
function renderCompleteRetry(
  c: Context,
  ctx: ShellContext,
  state: string,
  capture: InterviewCapture,
  opts: { error?: string; ownerError?: string; ownerDefault: string; deployOptions: DeployOption[] },
) {
  return renderShell(
    c,
    ctx,
    { title: "tanren · new project" },
    <GreenfieldBody
      step={1}
      interview={{
        round: 14,
        totalRounds: 14,
        say:
          opts.ownerError === undefined
            ? "Derive failed — try again."
            : "Almost there — confirm the repo owner, then derive.",
        suggestions: [],
        priorAnswer: "",
        capture,
        complete: true,
        state,
        ownerDefault: opts.ownerDefault,
        ...(opts.ownerError === undefined ? {} : { ownerError: opts.ownerError }),
        deployOptions: opts.deployOptions,
      }}
      error={opts.error}
      csrfToken={ctx.csrfToken}
    />,
  );
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
  } catch {
    return undefined;
  }
}
