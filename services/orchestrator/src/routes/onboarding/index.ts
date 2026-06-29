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
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import { provisionAutonomousProject } from "../../engine/workflow/provisionAutonomousProject.js";
import {
  DeployNotLinkedError,
  DeployProviderInvalidError,
  DeployProviderMissingError,
  DeployProvisioningUnavailableError,
  deriveFromCapture,
  DeriveRollbackError,
  FragmentAuthoringFailedError,
  InterviewCapture,
  MissingLifecycleError,
  MissingProjectSlugError,
  runRound,
  UnresolvableLifecycleError,
  type DeployPreflightCallback,
  type InterviewAnswerer,
  type PrepareDeployCallback,
} from "../../engine/forge/interview/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import type { DesignAgent } from "../../engine/design/designAgent.js";
import type { MaterializeTemplate } from "../../engine/templates/fragments/materialize.js";
import type { FragmentAuthoring, FragmentLibrary } from "../../engine/templates/index.js";
export { buildLiveMaterializeTemplate } from "./materializeTemplate.js";
export { buildLiveRunFragmentAuthoring, buildLiveLoadFragmentLibrary } from "./fragmentAuthoring.js";
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
import { destroyGreenfieldDeployApp } from "../projects/greenfieldDeployDestroy.js";

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
}

const RoundBody = z
  .object({
    round: z.number().int().min(1).max(100),
    answer: z.string().max(8000).default(""),
    capture: InterviewCapture.default(InterviewCapture.parse({})),
  })
  .strict();

const DeriveBody = z
  .object({
    capture: InterviewCapture,
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
    try {
      const result = await runRound({ pool: options.pool, answerer: options.answererFactory({ orgId }) }, parsed.data);
      return c.json(result, 200);
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
    try {
      const preflightDeploy =
        options.preflightDeploy ??
        ((input) => preflightGreenfieldDeploy(options.pool, input.orgId, input.providerKind, actor.userId));
      const prepareDeploy =
        options.prepareDeploy ??
        ((input) =>
          prepareGreenfieldDeploy({
            pool: options.pool,
            secrets: options.secrets,
            orgId: input.orgId,
            actorId: actor.userId,
            projectKey: input.projectKey,
            projectName: input.projectName,
            deploy: input,
          }));
      if (options.githubHttp === undefined) {
        return c.json({ error: "vcs_provider_missing" }, 500);
      }
      const githubHttp = options.githubHttp;
      const result = await deriveFromCapture(
        { pool: options.pool, preflightDeploy, prepareDeploy },
        {
          orgId,
          capture: parsed.data.capture,
          actor: { ...actor, orgId },
          owner: parsed.data.owner,
          ...(parsed.data.private === undefined ? {} : { private: parsed.data.private }),
          ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
          createRepository: (input) =>
            createGreenfieldRepository({
              pool: options.pool,
              secrets: options.secrets,
              githubHttp,
              orgId,
              ...(options.githubAppMinter === undefined ? {} : { githubAppMinter: options.githubAppMinter }),
              input,
            }),
          // TASK #78 — derive transactional rollback. Threads the repo-DELETE
          // compensation through the same credential context the create uses,
          // so a derive that creates a repo + then fails later in the call
          // walks back and deletes it before re-raising.
          deleteRepository: (target) =>
            deleteGreenfieldRepository({
              pool: options.pool,
              secrets: options.secrets,
              githubHttp,
              orgId,
              ...(options.githubAppMinter === undefined ? {} : { githubAppMinter: options.githubAppMinter }),
              target,
            }),
          ...(parsed.data.autonomy === undefined ? {} : { autonomy: parsed.data.autonomy }),
          ...(parsed.data.deploy === undefined ? {} : { deploy: parsed.data.deploy }),
          // TASK #78 — derive transactional rollback. Threads the deploy-DESTROY
          // compensation through the same org grant + provisioner registry the
          // prepareDeploy uses, so a derive that provisions a deploy app + then
          // fails later in the call destroys it before re-raising.
          destroyDeployApp: (target) =>
            destroyGreenfieldDeployApp({
              pool: options.pool,
              secrets: options.secrets,
              orgId,
              actorId: actor.userId,
              target,
            }),
          // WS-D3: resolve the design agent for THIS org so the derive's design phase
          // elaborates the captured intent into the designed HEAD `DesignContract`.
          ...(options.designAgentFactory === undefined ? {} : { designAgent: options.designAgentFactory({ orgId }) }),
          // The compose+materialize seam (docs/roadmap/templating-system.md).
          ...(options.materializeTemplate === undefined
            ? {}
            : {
                materializeTemplate: options.materializeTemplate({
                  orgId,
                  actor: { ...actor, orgId },
                }),
              }),
          // F2 — per-fragment authoring DAG (runs on missing-fragments decisions).
          ...(options.runFragmentAuthoring === undefined
            ? {}
            : {
                runFragmentAuthoring: options.runFragmentAuthoring({
                  orgId,
                  actor: { ...actor, orgId },
                }),
              }),
          // F2 — unified library (bundled + org-authored fragments).
          ...(options.loadFragmentLibrary === undefined
            ? {}
            : { fragmentLibrary: await options.loadFragmentLibrary(orgId) }),
        },
      );
      if (result.repository === undefined) {
        throw new Error("greenfield repository missing after derive");
      }
      const bootstrap = await provisionAutonomousProject({
        pool: options.pool,
        orgId,
        projectId: result.projectId,
        repoUrl: result.repository.repoUrl,
      });
      return c.json({ ...result, inboxSource: bootstrap.inboxSource, bootstrap }, 201);
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
      if (error instanceof ProjectNotFoundError) {
        return respond({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return respond({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecNotFoundError) {
        return respond({ error: "spec_dependency_not_found", message: error.message }, 404);
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
      if (error instanceof DeployProvisioningUnavailableError) {
        return respond({ error: "deploy_provisioning_unavailable", message: error.message }, 500);
      }
      // Lifecycle so malformed we can't even synthesize a template config (empty
      // stack, no derivable runtime). A bad/incomplete capture (400).
      if (error instanceof UnresolvableLifecycleError) {
        return respond({ error: "lifecycle_unresolvable", message: error.message }, 400);
      }
      // One or more per-fragment authoring runs failed at their fixed point. The
      // derive halts loud per doctrine (no silent skip). Surfaced as 409
      // needs_attention — an operator inspects the `fragment.authoring.failed`
      // events, fixes the writer / validator, and retries.
      if (error instanceof FragmentAuthoringFailedError) {
        return respond(
          {
            error: "fragment_authoring_failed",
            capability: "fragments",
            failedIds: error.failedIds,
            // v66 fix: surface the per-fragment writer rejection reason on the 409
            // body so the operator can read WHY F2 halted directly off the
            // response — no orchestrator-log grepping. Keyed by fragment id; value
            // is the LAST rejection captured by F2 at the fixed point.
            failureReasons: error.failureReasons,
            message: error.message,
          },
          409,
        );
      }
      if (error instanceof Error && error.message.startsWith("deploy provision failed:")) {
        return respond({ error: "deploy_provision_failed", message: error.message }, 502);
      }
      return respond({ error: "interview_derive_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
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
