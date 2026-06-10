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
// fallback (§8a). Mounted on the same `/orgs` base as the other product routes.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import { runWithOrgScope } from "@tanren/db";
import type { ActorContext } from "../../auth/schemas.js";
import { TemplateStore } from "../../engine/repositories/index.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { VcsProvider } from "../../engine/contracts/vcsProvider.js";
import { ensureIssuesInboxSource } from "../../engine/forge/inbox/index.js";
import { ensureDefaultNotificationRoute } from "../../engine/notifications/index.js";
import {
  DeployNotLinkedError,
  DeployProviderInvalidError,
  DeployProviderMissingError,
  DeployProvisioningUnavailableError,
  deriveFromCapture,
  InterviewCapture,
  MissingLifecycleError,
  MissingProjectSlugError,
  runRound,
  type DeployPreflightCallback,
  type InterviewAnswerer,
  type PrepareDeployCallback,
} from "../../engine/forge/interview/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import type { SelectedTemplate, TemplateRegistryQuery } from "../../engine/forge/interview/templateSelection.js";
import type { CaptureLifecycle } from "../../engine/forge/interview/types.js";
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

export interface OnboardingRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  // The interview answerer factory, called per-request with the request's org so
  // the answerer resolves the org's default `forge`/LLM credential (greenfield —
  // no project exists yet). Production passes `buildForgeInterviewAnswererFactory`
  // (a real provider answerer); tests pass a fake. REQUIRED — no fallback.
  answererFactory: (target: ForgeAnswererTarget) => InterviewAnswerer;
  vcsProvider?: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  preflightDeploy?: DeployPreflightCallback;
  prepareDeploy?: PrepareDeployCallback;
  // TEMPLATING WAVE 4 (templating-system.md §3): the SELECTION no-match → CREATION
  // wiring. When supplied, onboarding's template selection CREATES a template (the
  // creation meta-flow) when no validated one matches + SEEDS from it, instead of
  // falling to from-scratch. A per-request BUILDER (given the org/actor/registry
  // query) of the decoupled `createForNoMatch` seam — so the onboarding route keeps
  // NO direct creation dependency (the builder is wired at the mount layer via
  // `buildCreateForNoMatch`). Absent ⇒ the from-scratch path (today's default).
  createTemplateForNoMatch?: (ctx: {
    orgId: string;
    actor: ActorContext;
    templateRegistryQuery: TemplateRegistryQuery;
    // The REAL GitHub repo owner the new template repo lands under — threaded from the
    // derive request's `owner` so `maybeCreateTemplateForNoMatch` can actually create
    // (without it the create path had no owner and silently no-op'd; audit §3.11/2).
    repoOwner: string;
  }) => (lifecycle: CaptureLifecycle) => Promise<SelectedTemplate | undefined>;
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
      if (options.vcsProvider === undefined) {
        return c.json({ error: "vcs_provider_missing" }, 500);
      }
      const templateRegistryQuery: TemplateRegistryQuery = (query, queryActor) =>
        runWithOrgScope(options.pool, orgId, (client) => TemplateStore.listByCapabilities(client, query, queryActor));
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
              vcsProvider: options.vcsProvider as VcsProvider,
              orgId,
              ...(options.githubAppMinter === undefined ? {} : { githubAppMinter: options.githubAppMinter }),
              input,
            }),
          ...(parsed.data.autonomy === undefined ? {} : { autonomy: parsed.data.autonomy }),
          ...(parsed.data.deploy === undefined ? {} : { deploy: parsed.data.deploy }),
          // TEMPLATING WAVE 3 (templating-system.md §3): the ORG-SCOPED template
          // registry query. Each call opens a short `runWithOrgScope` so RLS bounds
          // the candidates to THIS org's own templates PLUS the cross-org `official`
          // catalogue — an off-scope template is never even a candidate.
          templateRegistryQuery,
          // TEMPLATING WAVE 4 (templating-system.md §3): the no-match → CREATION
          // seam. When the mount wired a builder, selection CREATES + SEEDS on no
          // match (via the SAME org-scoped registry query); absent ⇒ from-scratch.
          ...(options.createTemplateForNoMatch === undefined
            ? {}
            : {
                createTemplateForNoMatch: options.createTemplateForNoMatch({
                  orgId,
                  actor: { ...actor, orgId },
                  templateRegistryQuery,
                  // Thread the REAL repo owner from the derive request so the no-match
                  // CREATE path lands the template repo under it (audit §3.11/2).
                  repoOwner: parsed.data.owner,
                }),
              }),
        },
      );
      if (result.repository === undefined) {
        throw new Error("greenfield repository missing after derive");
      }
      const inbox = await ensureIssuesInboxSource({
        pool: options.pool,
        orgId,
        projectId: result.projectId,
        repoUrl: result.repository.repoUrl,
      });
      // api-mirrors-ux + no-silent: seed the per-org DEFAULT ntfy notification
      // route so the apex-critical milestone events (budget / deploy.verified /
      // needs_attention) reach a human on the dashboard-visible matrix BY DEFAULT
      // — the operator-drivable path a real user would otherwise hand-configure.
      // The topic is the per-tenant `tanren-org-<orgId>` bus on the deploy-default
      // ntfy host (the per-target base URL stays null ⇒ the boot default applies).
      //
      // The repo + project are already COMMITTED at this point, so a seed failure
      // must NOT 500-after-side-effects (the create would otherwise be irreversibly
      // half-done). It is LOUD (console.error, never silent) but non-fatal: the
      // code-level env default route still guarantees milestone delivery, and the
      // operator can add the per-org route from the dashboard.
      let notificationRoute: { seeded: false } | { seeded: true; targetId: string; created: boolean; events: number } =
        {
          seeded: false,
        };
      try {
        const notify = await ensureDefaultNotificationRoute({
          pool: options.pool,
          orgId,
          ntfyTopic: `tanren-org-${orgId}`,
        });
        notificationRoute = {
          seeded: true,
          targetId: notify.target.id,
          created: notify.created,
          events: notify.routes.length,
        };
      } catch (seedError) {
        console.error(
          `[onboarding] default notification route seed failed for org ${orgId} (delivery still covered by the env default):`,
          seedError instanceof Error ? seedError.message : seedError,
        );
      }
      return c.json(
        { ...result, inboxSource: { id: inbox.source.id, created: inbox.created }, notificationRoute },
        201,
      );
    } catch (error) {
      const repoError = greenfieldRepositoryErrorResponse(c, error);
      if (repoError !== undefined) return repoError;
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_dependency_not_found", message: error.message }, 404);
      }
      // The architecture step never captured a project lifecycle — the scaffold
      // can't author a justfile without it. A bad/incomplete capture (400), NOT a
      // silent Node default (stack-flexible contract).
      if (error instanceof MissingLifecycleError) {
        return c.json({ error: "lifecycle_missing", message: error.message }, 400);
      }
      // The capture surfaced no hostname-safe project slug (no identity + no usable
      // pitch/design-DNA/stack fallback). A bad/incomplete capture (400), NOT a silent
      // shared default repo name.
      if (error instanceof MissingProjectSlugError) {
        return c.json({ error: "project_slug_missing", message: error.message }, 400);
      }
      if (error instanceof DeployProviderMissingError) {
        return c.json(
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
        return c.json(
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
        return c.json({ error: "deploy_not_linked", ...error.outcome }, 409);
      }
      if (error instanceof DeployProvisioningUnavailableError) {
        return c.json({ error: "deploy_provisioning_unavailable", message: error.message }, 500);
      }
      if (error instanceof Error && error.message.startsWith("deploy provision failed:")) {
        return c.json({ error: "deploy_provision_failed", message: error.message }, 502);
      }
      return c.json({ error: "interview_derive_failed", message: messageOf(error) }, 500);
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
