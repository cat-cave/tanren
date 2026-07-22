// rv-21 — test harness for the onboarding interview → derive route against real pg.
// Owns the heavy route-mount + deploy/bootstrap seam wiring so the RLS test file stays
// under the module-dependency cap. The derive runs on the OWNER connection (as the real
// app pool does — its internal project-config CAS is not org-scoped); RLS isolation is
// proven on the verification reads in the test, which run through the restricted
// `tanren_app` role under `runWithOrgScope`.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type { Pool } from "pg";
import type { ActorContext } from "../../src/auth/schemas.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { InterviewAnswerer } from "../../src/engine/forge/interview/index.js";
import { provisionAutonomousProject } from "../../src/engine/workflow/provisionAutonomousProject.js";
import { createAuthMiddleware, type ActorContextEnv } from "../../src/middleware/auth.js";
import { createOnboardingRoutes } from "../../src/routes/onboarding/index.js";
import { persistGreenfieldDeploySelection } from "../../src/routes/projects/greenfieldDeployAuthority.js";
import { FakeRepoCreateHttp } from "../conformance/fakes/fakeRepoCreateHttp.js";
import { preparedDeploy } from "../fixtures/forge/interviewDeriveStub.js";
import { SEED, seedActivationPrerequisites } from "../fixtures/projectDerivationLifecycle.js";

export { FakeRepoCreateHttp };

export interface Rv21HarnessOptions {
  owner: Pool;
  runtime: Pool;
  githubHttp: FakeRepoCreateHttp;
  actor: ActorContext;
  org: string;
  staticTokenRef: string;
  answerer: InterviewAnswerer;
}

/** Seed the org's deploy connection + grant (no projects — the derive creates the
 * project, and its injected prepareDeploy persists the project-scoped grant selection). */
export async function seedRv21DeployConnection(runtime: Pool, org: string): Promise<void> {
  await seedActivationPrerequisites(runtime, org, []);
}

/** Mount the onboarding routes with the injected answerer + the deploy/bootstrap seams a
 * fully-successful real-pg derive needs. */
export function mountRv21OnboardingApp(options: Rv21HarnessOptions): Hono<ActorContextEnv> {
  const { owner, runtime, githubHttp, actor, org, staticTokenRef, answerer } = options;
  const secrets = new InMemorySecretStore();
  void secrets.put({ ref: staticTokenRef, value: "ghp_rv21_repo_create_token" });
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route(
    "/orgs",
    createOnboardingRoutes({
      pool: owner,
      secrets,
      answererFactory: () => answerer,
      githubHttp,
      // No design agent ⇒ CAPTURED mode: the explicit design seed is persisted verbatim
      // as version 1, its persona/behavior refs bound to the real derived entity ids.
      async preflightDeploy() {},
      async prepareDeploy(input) {
        // Persist the project's exact deploy-grant selection (the real authority the
        // derive's activation re-validates the receipt against), then return the
        // provisioned receipt whose authority matches the seeded connection/grant.
        await runWithOrgScope(runtime, org, (client) =>
          persistGreenfieldDeploySelection(
            client,
            {
              orgId: org,
              projectId: input.projectId,
              providerKind: "deploy.vercel",
              connectionId: "connection_1",
              grantId: "grant_1",
              authGeneration: 1,
              grantGeneration: 1,
            },
            actor.userId,
          ),
        );
        return preparedDeploy("deploy.vercel");
      },
      async persistDeploySelection() {},
      materializeTemplate: () => async () => SEED,
      composeDesignSystem: () => async () => {},
      // The real autonomous bootstrap — it creates the durable activation prerequisites
      // (inbox source, notification route, audit catalog) the derive's activate validates.
      bootstrapProject: (bootstrapInput) => provisionAutonomousProject(bootstrapInput),
    }),
  );
  return app;
}
