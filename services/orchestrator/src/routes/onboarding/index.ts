// greenfield-onboarding HTTP routes (vision interview → derive).
//
//   POST /:orgId/onboarding/interview/round
//     Body: { round, answer, capture }. Runs ONE interview round over the
//     injectable answerer and returns the next question + the updated capture.
//     Persists nothing — the surface re-submits the running capture (pause/
//     resume = stash it client-side), so there is no interview-session table.
//
//   POST /:orgId/onboarding/interview/derive
//     Body: { capture, owner, private?, description? }. On completion, creates
//     the real greenfield repo and derives the product graph —
//     project + personas/behaviors/milestones/specs — through the existing
//     creation paths and returns the new project + derived ids.
//     The DAG is then read back via the existing project-DAG endpoint.
//
// The answerer is resolved per-request from the request's org via
// `answererFactory(target)` — production wires `buildForgeInterviewAnswererFactory`
// (a REAL provider answerer that derives personas/behaviors/milestones with a
// model); tests inject a fake. Greenfield onboarding has no project yet, so the
// answerer resolves the ORG's default LLM credential. There is no deterministic
// fallback (§8a).

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { CreateRepositoryInput } from "../../engine/contracts/codeHostTypes.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import {
  DeployNotLinkedError,
  DeploySelectionRequiredError,
  DeployProviderInvalidError,
  DeployProviderMissingError,
  DeployProvisioningUnavailableError,
  deriveFromCapture,
  DeriveRollbackError,
  DesignCoverageMismatchError,
  FragmentAuthoringFailedError,
  InterviewCapture,
  InterviewIncompleteError,
  JitBuildRequiredError,
  MissingLifecycleError,
  MissingProjectSlugError,
  ProjectBootstrapIncompleteError,
  ProjectDerivationConflictError,
  ProjectDesignElaborationStateUnknownError,
  runRound,
  UnresolvableLifecycleError,
  type ComposeDesignSystemCallback,
  type DeployPreflightCallback,
  type InterviewAnswerer,
  type PersistDeploySelectionCallback,
  type PrepareDeployCallback,
} from "../../engine/forge/interview/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import type { DesignAgent } from "../../engine/design/designAgent.js";
import { DesignFragmentAuthoringFailedError } from "../../engine/design/system/authoring/index.js";
import type { MaterializeTemplate } from "../../engine/templates/fragments/materialize.js";
import type { FragmentAuthoring, FragmentLibrary } from "../../engine/templates/index.js";
import {
  InvalidOnboardingStateError,
  OnboardingStateSigner,
  type InterviewStatePayload,
} from "../../engine/forge/onboardingState.js";
export { buildLiveMaterializeTemplate } from "./materializeTemplate.js";
export {
  buildLiveFragmentAuthoringDeps,
  buildLiveLoadFragmentLibrary,
  buildLiveRunFragmentAuthoring,
  buildLiveRuntimeValiditySmokeDeps,
  type FragmentAuthoringFlowDeps,
} from "./fragmentAuthoring.js";
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecNotFoundError,
} from "../../engine/workflow/projectSpec.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import {
  createGreenfieldRepository,
  GreenfieldDeploySchema,
  greenfieldRepositoryErrorResponse,
  SUPPORTED_DEPLOY_PROVIDER_KINDS,
  prepareGreenfieldDeploy,
  preflightGreenfieldDeploy,
} from "../projects/greenfield.js";
import { deleteGreenfieldRepository } from "../projects/greenfieldRepoDelete.js";
import { probeGreenfieldRepositoryBareAutoInit } from "../projects/greenfieldRepoProbe.js";
import { persistGreenfieldDeploySelection } from "../projects/greenfieldDeployAuthority.js";

export interface OnboardingRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  // The interview answerer factory, called per-request with the request's org so
  // the answerer resolves the org's default `forge`/LLM credential (greenfield —
  // no project exists yet). Production passes `buildForgeInterviewAnswererFactory`
  // (a real provider answerer); tests pass a fake. REQUIRED — no fallback.
  answererFactory: (target: ForgeAnswererTarget) => InterviewAnswerer;
  // WS-D3 (native-design-subsystem.md): the DESIGN-AGENT factory, called per-request
  // with the request's org so the agent resolves the org's default LLM credential
  // (greenfield — no project yet). When wired, the derive's design PHASE elaborates
  // the captured intent into the designed HEAD `DesignContract` before the build
  // nodes run; production passes `buildForgeDesignAgentFactory`. Absent ⇒ the thin
  // captured contract is persisted verbatim (the injected-seam path).
  designAgentFactory?: (target: ForgeAnswererTarget) => DesignAgent;
  githubHttp?: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  preflightDeploy?: DeployPreflightCallback;
  prepareDeploy?: PrepareDeployCallback;
  /** Test seam; production persists through the greenfield authority below. */
  persistDeploySelection?: PersistDeploySelectionCallback;
  // The COMPOSE+MATERIALIZE seam (docs/roadmap/templating-system.md). Every
  // greenfield derive composes a fragment-based template from the captured
  // lifecycle and materializes it into a fresh seed repo — this seam does the
  // create-repo + push-files work.
  materializeTemplate?: (ctx: { orgId: string; actor: ActorContext }) => MaterializeTemplate;
  /** PER-FRAGMENT AUTHORING seam (F2): the derive calls this on a
   * missing-fragments decision to author the missing fragments, persist them,
   * and retry. */
  runFragmentAuthoring?: (ctx: { orgId: string; actor: ActorContext }) => FragmentAuthoring;
  /** UNIFIED LIBRARY LOADER (F2): combines bundled core + org-authored
   * fragments (the per-org `fragments` table). */
  loadFragmentLibrary?: (orgId: string) => Promise<FragmentLibrary>;
  /** ds-composer — the DESIGN-SYSTEM COMPOSITION seam. Called per-request with the
   * request's org so the composer resolves the org's default LLM credential (the F2D
   * writer) + org-scoped stores; the derive runs it once the HEAD contract exists. */
  composeDesignSystem?: (ctx: { orgId: string; actor: ActorContext }) => ComposeDesignSystemCallback;
  /** Test seam; production omits this and executes the real bootstrap. */
  bootstrapProject?: NonNullable<Parameters<typeof deriveFromCapture>[1]["bootstrapProject"]>;
}

const RoundBody = z
  .object({
    round: z.number().int().min(1).max(100),
    answer: z.string().max(8000).default(""),
    state: z.string().min(1).max(500_000).optional(),
  })
  .strict();

// Build the three greenfield repo-lifecycle callbacks the derive threads (all over the
// SAME org credential context): CREATE (`CodeHost.createRepo`), DELETE (task #78
// rollback compensation), and the apex-v84 emptiness PROBE gating the re-attach branch.
// Extracted so the derive route handler stays under the per-function line cap.
function buildGreenfieldRepoCallbacks(options: OnboardingRoutesOptions, githubHttp: GitHubHttpClient, orgId: string) {
  const minter = options.githubAppMinter === undefined ? {} : { githubAppMinter: options.githubAppMinter };
  const base = { pool: options.pool, secrets: options.secrets, githubHttp, orgId, ...minter };
  return {
    createRepository: (input: CreateRepositoryInput) => createGreenfieldRepository({ ...base, input }),
    deleteRepository: (target: { owner: string; name: string }) => deleteGreenfieldRepository({ ...base, target }),
    probeRepoBareAutoInit: (target: { owner: string; name: string }) =>
      probeGreenfieldRepositoryBareAutoInit({ ...base, target }),
  };
}

const DeriveBody = z
  .object({
    state: z.string().min(1).max(500_000),
    owner: z.string().min(1).max(100),
    private: z.boolean().optional(),
    description: z.string().min(1).max(400).optional(),
    // GREENFIELD AUTONOMY: how the derived project is governed at creation. When
    // `auto`/`simulated`, the project lands ALREADY autonomous (a `native_queue`
    // merge engine + the matching review policy) so the DagWalker can advance it
    // off an empty repo with NO follow-up PATCH. Absent or `human` ⇒ the schema's
    // safe defaults (human review, `not_configured` merge), unchanged — the
    // brownfield/managed default.
    autonomy: z.enum(["auto", "simulated", "human"]).optional(),
    deploy: GreenfieldDeploySchema.optional(),
  })
  .strict();

export function createOnboardingRoutes(options: OnboardingRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const stateSigner = new OnboardingStateSigner(options.secrets);

  app.post("/:orgId/onboarding/interview/round", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = RoundBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_round", issues: parsed.error.issues }, 400);
    }
    let capture = InterviewCapture.parse({});
    if (parsed.data.state !== undefined) {
      try {
        const state = await stateSigner.verifyInterview(parsed.data.state, orgId);
        if (state.nextRound !== parsed.data.round) {
          return c.json({ error: "invalid_onboarding_state", reason: "stale" }, 400);
        }
        capture = state.capture;
      } catch (error) {
        if (!(error instanceof InvalidOnboardingStateError)) {
          return c.json({ error: "interview_round_failed", message: messageOf(error) }, 500);
        }
        return invalidStateResponse(error);
      }
    } else if (parsed.data.round !== 1) {
      return c.json({ error: "invalid_onboarding_state", reason: "missing" }, 400);
    }
    try {
      const result = await runRound(
        { pool: options.pool, answerer: options.answererFactory({ orgId }) },
        { round: parsed.data.round, answer: parsed.data.answer, capture },
      );
      const state = await stateSigner.signInterview({ orgId, nextRound: result.round + 1, capture: result.capture });
      return c.json({ ...result, state }, 200);
    } catch (error) {
      return c.json({ error: "interview_round_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/onboarding/interview/derive", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = DeriveBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_derive", issues: parsed.error.issues }, 400);
    }
    let state: InterviewStatePayload;
    try {
      state = await stateSigner.verifyInterview(parsed.data.state, orgId);
    } catch (error) {
      if (!(error instanceof InvalidOnboardingStateError)) {
        return c.json({ error: "interview_derive_failed", message: messageOf(error) }, 500);
      }
      return invalidStateResponse(error);
    }
    try {
      if (options.githubHttp === undefined) return c.json({ error: "vcs_provider_missing" }, 500);
      const result = await runInterviewDerive({ options, actor, orgId, state, input: parsed.data });
      if (result.repository === undefined) {
        throw new Error("greenfield repository missing after derive");
      }
      if (result.bootstrap === undefined) throw new Error("greenfield derivation completed without bootstrap receipt");
      return c.json({ ...result, inboxSource: result.bootstrap.inboxSource }, 201);
    } catch (caught) {
      // TASK #78 — derive transactional rollback. A `DeriveRollbackError` wraps the
      // ORIGINAL failure (as `cause`) + the list of compensations that FAILED
      // during rollback. NORMALIZE here so the typed-error dispatch below fires on
      // the ORIGINAL cause (a `GithubCredentialMissingError` should still map to
      // 400, not be buried as a generic 500); the `orphanedResources` rider is
      // attached to the response so the operator sees BOTH the original failure +
      // any resource the rollback could not undo. On a successful rollback (no
      // compensation gap), derive throws the original error verbatim — no wrap.
      const error = caught instanceof DeriveRollbackError ? (caught.cause ?? caught) : caught;
      const orphans =
        caught instanceof DeriveRollbackError
          ? caught.compensationFailures.map((f) => ({
              kind: f.kind,
              resource: f.label,
              reason: f.error instanceof Error ? f.error.message : String(f.error),
            }))
          : undefined;
      // Attach the orphan rider onto the eventual JSON response. Returns a wrapper
      // around `c.json` that merges `{ orphanedResources: [...] }` when present.
      const respond = (body: Record<string, unknown>, status: number): Response =>
        c.json(orphans === undefined ? body : { ...body, orphanedResources: orphans }, status as never);
      const repoError = greenfieldRepositoryErrorResponse(c, error, orphans);
      if (repoError !== undefined) return repoError;
      // rv-21 — the derive boundary rejected an INCOMPLETE / self-inconsistent capture
      // (missing a required area OR a dangling persona/behavior ref) BEFORE any repository /
      // project / design-contract row was created: a typed 409 carrying the exact missing +
      // invalid areas, never a generic 500 and never a partial derive off a half vision.
      if (error instanceof InterviewIncompleteError) {
        return respond(
          { error: "interview_incomplete", missing: error.missing, invalid: error.invalid, message: error.message },
          409,
        );
      }
      // rv-21 (proof=effect) — the synthesized design contract did not cover exactly the
      // persisted persona/behavior graph; the derive failed closed (no contract row, the
      // graph rolled back). A typed fault, never a silent success with a narrowed obligation.
      if (error instanceof DesignCoverageMismatchError) {
        return respond({ error: "design_coverage_mismatch", message: error.message }, 500);
      }
      if (error instanceof ProjectNotFoundError) {
        return respond({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return respond({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecNotFoundError) {
        return respond({ error: "spec_dependency_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectDerivationConflictError) {
        return respond({ error: "project_derivation_conflict", reason: error.reason, message: error.message }, 409);
      }
      if (error instanceof ProjectBootstrapIncompleteError) {
        return respond({ error: "project_bootstrap_incomplete", bootstrap: error.bootstrap }, 503);
      }
      if (error instanceof ProjectDesignElaborationStateUnknownError) {
        return respond(
          {
            error: "project_design_elaboration_state_unknown",
            reason: "state_unknown",
            derivationId: error.derivationId,
            message: error.message,
          },
          409,
        );
      }
      // The architecture step never captured a project lifecycle — the scaffold
      // can't author a justfile without it. A bad/incomplete capture (400), NOT a
      // silent Node default (stack-flexible contract).
      if (error instanceof MissingLifecycleError) {
        return respond({ error: "lifecycle_missing", message: error.message }, 400);
      }
      // The capture surfaced no hostname-safe project slug (no identity + no usable
      // pitch/design-DNA/stack fallback). A bad/incomplete capture (400), NOT a silent
      // shared default repo name.
      if (error instanceof MissingProjectSlugError) {
        return respond({ error: "project_slug_missing", message: error.message }, 400);
      }
      if (error instanceof DeployProviderMissingError) {
        return respond(
          {
            error: "deploy_provider_missing",
            capability: "deploy",
            supportedProviderKinds: SUPPORTED_DEPLOY_PROVIDER_KINDS,
            message: error.message,
          },
          400,
        );
      }
      if (error instanceof DeployProviderInvalidError) {
        return respond(
          {
            error: "deploy_provider_invalid",
            capability: "deploy",
            supportedProviderKinds: SUPPORTED_DEPLOY_PROVIDER_KINDS,
            message: error.message,
          },
          400,
        );
      }
      if (error instanceof DeployNotLinkedError) {
        return respond({ error: "deploy_not_linked", ...error.outcome }, 409);
      }
      if (error instanceof DeploySelectionRequiredError) {
        return respond({ error: "deploy_selection_required", ...error.outcome }, 409);
      }
      if (error instanceof DeployProvisioningUnavailableError) {
        return respond({ error: "deploy_provisioning_unavailable", message: error.message }, 500);
      }
      // Lifecycle so malformed we can't even synthesize a template config (empty
      // stack, no derivable runtime). A bad/incomplete capture (400).
      if (error instanceof UnresolvableLifecycleError) {
        return respond({ error: "lifecycle_unresolvable", message: error.message }, 400);
      }
      // H1 #4 — the captured toolchain is off the golden baseline AND this
      // deployment has no `TANREN_ENV_REGISTRY` configured, so the runner would
      // have no validated env image to seed from. A LOUD config gap surfaced at
      // project-create time rather than a mysterious runtime failure on the first
      // run (doctrine env-management.md §2.2 — halt loud).
      if (error instanceof JitBuildRequiredError) {
        return respond(
          {
            error: "jit_build_required",
            capability: "environment",
            toolchain: error.toolchain,
            message: error.message,
          },
          400,
        );
      }
      // An authoring loop (code-F2 fragments OR ds-composer design-F2D) halted at its
      // fixed point (no silent skip). Both map to a typed 409 needs_attention carrying
      // the failed ids + per-unit rejection reasons on the body, so an operator reads
      // WHY it halted off the response (no log grepping) and inspects the matching
      // `*.authoring.failed` events — never a generic 500.
      if (error instanceof FragmentAuthoringFailedError) {
        return respond(authoringFailedBody("fragment_authoring_failed", "fragments", error), 409);
      }
      if (error instanceof DesignFragmentAuthoringFailedError) {
        return respond(authoringFailedBody("design_fragment_authoring_failed", "design_fragments", error), 409);
      }
      if (error instanceof Error && error.message.startsWith("deploy provision failed:")) {
        return respond({ error: "deploy_provision_failed", message: error.message }, 502);
      }
      return respond({ error: "interview_derive_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
}

async function runInterviewDerive(input: {
  options: OnboardingRoutesOptions;
  actor: ActorContext;
  orgId: string;
  state: InterviewStatePayload;
  input: z.infer<typeof DeriveBody>;
}) {
  const { options, actor, orgId, state, input: parsed } = input;
  const preflightDeploy =
    options.preflightDeploy ??
    ((value) => preflightGreenfieldDeploy({ client: options.pool, actorId: actor.userId, ...value }));
  const prepareDeploy =
    options.prepareDeploy ??
    ((value) =>
      prepareGreenfieldDeploy({
        pool: options.pool,
        secrets: options.secrets,
        orgId: value.orgId,
        projectId: value.projectId,
        actorId: actor.userId,
        projectKey: value.projectKey,
        projectName: value.projectName,
        deploy: value,
      }));
  return deriveFromCapture(
    { pool: options.pool, preflightDeploy, prepareDeploy },
    {
      orgId,
      capture: state.capture,
      actor: { ...actor, orgId },
      owner: parsed.owner,
      ...(parsed.private === undefined ? {} : { private: parsed.private }),
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      ...buildGreenfieldRepoCallbacks(options, options.githubHttp!, orgId),
      ...(parsed.autonomy === undefined ? {} : { autonomy: parsed.autonomy }),
      ...(parsed.deploy === undefined ? {} : { deploy: parsed.deploy }),
      persistDeploySelection:
        options.persistDeploySelection ??
        (async (selection) => {
          await persistGreenfieldDeploySelection(options.pool, selection, actor.userId);
        }),
      ...(options.designAgentFactory === undefined ? {} : { designAgent: options.designAgentFactory({ orgId }) }),
      ...(options.materializeTemplate === undefined
        ? {}
        : { materializeTemplate: options.materializeTemplate({ orgId, actor: { ...actor, orgId } }) }),
      ...(options.runFragmentAuthoring === undefined
        ? {}
        : { runFragmentAuthoring: options.runFragmentAuthoring({ orgId, actor: { ...actor, orgId } }) }),
      ...(options.loadFragmentLibrary === undefined
        ? {}
        : { fragmentLibrary: await options.loadFragmentLibrary(orgId) }),
      ...(options.composeDesignSystem === undefined
        ? {}
        : { composeDesignSystem: options.composeDesignSystem({ orgId, actor: { ...actor, orgId } }) }),
      ...(options.bootstrapProject === undefined ? {} : { bootstrapProject: options.bootstrapProject }),
    },
  );
}

/** The shared 409 body for an authoring fixed-point halt — both the code-F2
 * `FragmentAuthoringFailedError` and the ds-composer `DesignFragmentAuthoringFailedError`
 * carry `failedIds` + `failureReasons`, so one shape serves both typed arms. */
function authoringFailedBody(
  errorCode: string,
  capability: string,
  error: FragmentAuthoringFailedError | DesignFragmentAuthoringFailedError,
): Record<string, unknown> {
  return {
    error: errorCode,
    capability,
    failedIds: error.failedIds,
    failureReasons: error.failureReasons,
    message: error.message,
  };
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidStateResponse(error: unknown): Response {
  const reason = error instanceof InvalidOnboardingStateError ? error.reason : "malformed";
  return new Response(JSON.stringify({ error: "invalid_onboarding_state", reason }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}
