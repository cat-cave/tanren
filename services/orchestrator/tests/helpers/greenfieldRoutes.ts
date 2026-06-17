// Shared test helpers for the greenfield/apex deploy-dependency + idempotency route
// tests — extracted so both `greenfieldDeployRequiredRoutes.test.ts` and
// `greenfieldCreateIdempotency.test.ts` reuse one app-assembly + capture/deploy
// fixtures (and each file stays under the per-file line cap).

import { Hono } from "hono";
import type { ActorContext } from "../../src/auth/schemas.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import {
  emptyCapture,
  type InterviewAnswerer,
  type PreparedGreenfieldDeploy,
  type SelectedTemplate,
} from "../../src/engine/forge/interview/index.js";
import { GithubAppTokenMinter } from "../../src/engine/providers/githubAppTokenMinter.js";
import { createAuthMiddleware, type ActorContextEnv } from "../../src/middleware/auth.js";
import { createOnboardingRoutes, type OnboardingRoutesOptions } from "../../src/routes/onboarding/index.js";
import { createProjectRoutes } from "../../src/routes/projects/index.js";
import { FakeRepoCreateHttp } from "../conformance/fakes/fakeRepoCreateHttp.js";
import type { RoutesPool } from "./routesPool.js";

// The org-default static `github_token` ref `seedStaticTokenOrg` configures — the
// repo-create static-credential fallback path. Seeded into the secret store so the
// real `resolveVcsToken` static read resolves (decomposition PR-3: the route builds a
// real `GitHubCodeHost`, so the token resolution actually runs in tests now).
const STATIC_GITHUB_TOKEN_REF = "credential/github/org/org_acme/default";

// A fake App-installation minter: return a canned installation token so the App-org
// repo-create path resolves WITHOUT signing a JWT / hitting the network (mirrors the
// established test pattern). The static-org path reads the seeded secret instead.
function fakeGithubAppMinter(): GithubAppTokenMinter {
  const minter = new GithubAppTokenMinter({ secrets: new InMemorySecretStore() });
  minter.getInstallationToken = async () => "app-installation-token";
  minter.refreshInstallationToken = async () => "app-installation-token";
  return minter;
}

export const greenfieldActor: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const completingAnswerer: InterviewAnswerer = {
  async ask() {
    return { say: "done", captureDelta: {}, suggestions: [], complete: true };
  },
};

// A fixture validated template the no-match path "creates" + seeds from. DOCTRINE:
// a PROJECT DAG always seeds from a validated template (templating-system.md §3) — so
// the route helper wires a `createTemplateForNoMatch` that stands in for the live
// just-in-time creation, returning a published-template seed (the unit tests for the
// real creation meta-flow live in templateCreation*.test.ts). A test that wants to
// observe the NO-creation-seam HALT overrides this with `createTemplateForNoMatch: undefined`.
const seededTemplate: SelectedTemplate = {
  templateRef: "template_fixture",
  repoRef: "cat-cave/tanren-template-ts-next",
  validationProof: {
    positiveControlsPassed: true,
    negativeControls: { typecheck: "proven", lint: "proven", test: "proven", mutation: "n/a" },
    auditorClean: true,
    validatedAt: "2026-06-09T00:00:00.000Z",
    validatedSha: "abc1234",
  },
};

export function appWithGreenfieldRoutes(
  pool: RoutesPool,
  githubHttp: FakeRepoCreateHttp = new FakeRepoCreateHttp(),
  onboardingOverrides: Partial<
    Pick<OnboardingRoutesOptions, "preflightDeploy" | "prepareDeploy" | "createTemplateForNoMatch">
  > = {},
  // INFRA-FAILURE injection (decomposition PR-3): when set, the static-credential
  // secret read THROWS — exercising the no_silent_fallbacks fix that a token-resolution
  // INFRA failure (Vault outage / corrupt config) PROPAGATES as a 500, never mislabeled
  // `github_credential_missing` (a 400). The org still HAS a credential ref bound (the
  // precheck passes), so the throw is genuine infra, not a missing-credential gap.
  tokenResolutionInfraFailure = false,
) {
  const app = new Hono<ActorContextEnv>();
  const secrets = new InMemorySecretStore();
  if (tokenResolutionInfraFailure) {
    secrets.get = async () => {
      throw new Error("vault unreachable: dial tcp 127.0.0.1:8200: connection refused");
    };
  } else {
    // Seed the org-default static `github_token` secret so the static-credential
    // repo-create path resolves a real token (the App-org path uses the fake minter).
    void secrets.put({ ref: STATIC_GITHUB_TOKEN_REF, value: "ghp_static_repo_create_token" });
  }
  const githubAppMinter = fakeGithubAppMinter();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return greenfieldActor;
        },
      } as never,
      localDevActor: greenfieldActor,
    }),
  );
  app.route(
    "/orgs",
    createOnboardingRoutes({
      pool: pool.asPgPool(),
      secrets,
      answererFactory: () => completingAnswerer,
      githubHttp,
      githubAppMinter,
      // The empty fixture registry never matches, so the no-match → just-in-time
      // creation seam seeds from a fixture published template (the doctrine: never a
      // project-direct from-scratch scaffold). Overridable per test.
      createTemplateForNoMatch: () => async () => seededTemplate,
      ...onboardingOverrides,
    }),
  );
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets, githubHttp, githubAppMinter }));
  // `githubHttp` is the repo-create transport fake; its `createdRepositories` is the
  // assertable record of what the route created (the pre-decomposition tests asserted
  // on `vcsProvider.createdRepositories`).
  return { app, githubHttp };
}

export function preparedDeploy(
  providerKind: "deploy.vercel" | "deploy.flyio" = "deploy.vercel",
): PreparedGreenfieldDeploy {
  return {
    outcome: {
      status: "provisioned",
      capability: "deploy",
      providerKind,
      action: "provision",
      mode: "greenfield",
      secretRefNames: [`secret://deploy/${providerKind}/app_1/token`],
      surfaces: { projectConfigKeys: ["deployProvider", "deployAppId"], deployRef: `${providerKind}:app_1` },
    },
    projectConfig: { deployProvider: providerKind, deployAppId: "app_1", deployAppName: "apex-url-shortener-v22" },
  };
}

// The TS/pnpm lifecycle the architecture step captures (apex v27 default) — NOT a
// Tanren hardcode; required at derive (the scaffold can't author a justfile without it).
export const GREENFIELD_TS_LIFECYCLE = {
  stack: "ts/pnpm",
  // Fresh-repo-safe (apex v32): greenfield bootstrap is a non-frozen install that
  // generates the lockfile on a cold checkout (a frozen install bricks it).
  bootstrap: "pnpm install",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};

// A minimal, EXPLICIT design contract (native design subsystem, WS-D1). The design
// contract is REQUIRED at derive (the no-silent-noop guard, mirroring the lifecycle
// guard) — so a capture that should derive past the early guards carries an explicit
// design contract. Minimal by design: an explicit, design-light contract is valid; a
// SILENT absence is not.
export const GREENFIELD_DESIGN_CONTRACT = {
  domain: "saas-web",
  identity: "a clean, trustworthy operations surface",
  intent: "a calm, information-dense control surface an operator trusts at a glance",
  principles: [],
  constraints: [],
  personas: [],
  behaviors: [],
  dimensions: [],
};

// A capture WITH a lifecycle + an explicit design contract but no deploy — isolates the
// deploy-guard rejection so it does not trip the (earlier) missing-lifecycle / missing-
// design-contract guards.
export const captureWithLifecycle = () => ({
  ...emptyCapture(),
  lifecycle: GREENFIELD_TS_LIFECYCLE,
  designContract: GREENFIELD_DESIGN_CONTRACT,
});

export function apexCapture() {
  return {
    ...emptyCapture(),
    identity: { slug: "apex-url-shortener-v22", pitch: "A short link service for an operations team.", repoHint: "" },
    lifecycle: GREENFIELD_TS_LIFECYCLE,
    designContract: GREENFIELD_DESIGN_CONTRACT,
  };
}

export function seedGithubAppOrg(pool: RoutesPool): void {
  pool.seedOrg({
    id: "org_acme",
    config: {
      version: 1,
      github_app: {
        installationId: "137492334",
        appId: "123456",
        credentialRef: "credential/github_app/org/org_acme/default",
        installedAt: "2026-06-06T00:00:00.000Z",
      },
    },
  });
}

// An org that connected a static PAT (no GitHub App) — the documented fallback path
// for repo creation when the App is not installed / lacks administration:write.
export function seedStaticTokenOrg(pool: RoutesPool): void {
  pool.seedOrg({
    id: "org_acme",
    config: { version: 1, defaultCredentials: { github_token: "credential/github/org/org_acme/default" } },
  });
}
