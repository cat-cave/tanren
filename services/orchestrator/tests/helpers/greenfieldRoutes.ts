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
} from "../../src/engine/forge/interview/index.js";
import { OnboardingStateSigner } from "../../src/engine/forge/onboardingState.js";
import type { MaterializeTemplate, SeededTemplate } from "../../src/engine/templates/index.js";
import { GithubAppTokenMinter } from "../../src/engine/providers/githubAppTokenMinter.js";
import { createAuthMiddleware, type ActorContextEnv } from "../../src/middleware/auth.js";
import { createOnboardingRoutes, type OnboardingRoutesOptions } from "../../src/routes/onboarding/index.js";
import { createProjectRoutes } from "../../src/routes/projects/index.js";
import type { GreenfieldCreateDeps } from "../../src/routes/projects/greenfield.js";
import { FakeRepoCreateHttp } from "../conformance/fakes/fakeRepoCreateHttp.js";
import { completeCaptureExtras } from "../fixtures/forge/completeCapture.js";
import { RoutesPool } from "./routesPool.js";

// The org-default static `github_token` ref `seedStaticTokenOrg` configures — the
// repo-create static-credential fallback path. Seeded into the secret store so the
// real `resolveVcsToken` static read resolves (decomposition PR-3: the route builds a
// real `GitHubCodeHost`, so the token resolution actually runs in tests now).
const STATIC_GITHUB_TOKEN_REF = "credential/github/org/org_acme/default";
const ONBOARDING_STATE_TEST_KEY = "issue-830-onboarding-state-test-key-0123456789";
const ONBOARDING_STATE_REF = "platform/onboarding/state-signing";

export async function signedInterviewState(capture: unknown, secrets: InMemorySecretStore): Promise<string> {
  return new OnboardingStateSigner(secrets).signInterview({ orgId: "org_acme", nextRound: 1, capture });
}

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

// A fixture seed the compose+materialize stub returns. DOCTRINE (docs/roadmap/
// templating-system.md): every project DAG seeds from a fragment-composed
// template — the route helper wires a `materializeTemplate` stub that returns
// this fixture instead of touching GitHub for the per-file push. A test
// that wants the bare wiring path overrides this with `materializeTemplate: undefined`.
// PR-G (task #77) — opaque composed-template identifier; no GitHub repo at this ref.
const seededTemplate: SeededTemplate = {
  templateRef: "tanren://composed/test-fixture@abc1234deadbeef",
  validatedAt: "2026-06-09T00:00:00.000Z",
};

const stubMaterialize = (): MaterializeTemplate => async () => seededTemplate;

export function appWithGreenfieldRoutes(
  pool: RoutesPool,
  githubHttp: FakeRepoCreateHttp = new FakeRepoCreateHttp(),
  // The notify seams (`preflightNotify`/`prepareNotify`) route to the PROJECT
  // create state machine, not onboarding, so they are NOT keys on
  // `OnboardingRoutesOptions`; picking them there would violate the `keyof`
  // constraint. They live in a separate override type with their real
  // `GreenfieldCreateDeps` signatures, intersected with the onboarding pick.
  onboardingOverrides: Partial<
    Pick<
      OnboardingRoutesOptions,
      | "preflightDeploy"
      | "prepareDeploy"
      | "persistDeploySelection"
      | "materializeTemplate"
      | "runFragmentAuthoring"
      | "bootstrapProject"
      | "designAgentFactory"
      | "composeDesignSystem"
    >
  > & {
    preflightNotify?: GreenfieldCreateDeps["preflightNotify"];
    prepareNotify?: GreenfieldCreateDeps["prepareNotify"];
  } = {},
  // INFRA-FAILURE injection (decomposition PR-3): when set, the static-credential
  // secret read THROWS — exercising the no_silent_fallbacks fix that a token-resolution
  // INFRA failure (Vault outage / corrupt config) PROPAGATES as a 500, never mislabeled
  // `github_credential_missing` (a 400). The org still HAS a credential ref bound (the
  // precheck passes), so the throw is genuine infra, not a missing-credential gap.
  tokenResolutionInfraFailure = false,
) {
  const app = new Hono<ActorContextEnv>();
  const secrets = new InMemorySecretStore();
  void secrets.put({ ref: ONBOARDING_STATE_REF, value: ONBOARDING_STATE_TEST_KEY });
  const originalGet = secrets.get.bind(secrets);
  if (tokenResolutionInfraFailure) {
    secrets.get = async (ref) => {
      if (ref === STATIC_GITHUB_TOKEN_REF) {
        throw new Error("vault unreachable: dial tcp 127.0.0.1:8200: connection refused");
      }
      return originalGet(ref);
    };
  } else {
    // Seed the org-default static `github_token` secret so the static-credential
    // repo-create path resolves a real token (the App-org path uses the fake minter).
    void secrets.put({ ref: STATIC_GITHUB_TOKEN_REF, value: "ghp_static_repo_create_token" });
  }
  const githubAppMinter = fakeGithubAppMinter();
  const preflightDeploy = onboardingOverrides.preflightDeploy;
  const preflightNotify = onboardingOverrides.preflightNotify;
  const prepareDeploy = onboardingOverrides.prepareDeploy;
  const prepareNotify = onboardingOverrides.prepareNotify;
  const bootstrapProject =
    onboardingOverrides.bootstrapProject ??
    (async (input) => pool.seedDerivationBootstrap(input.orgId, input.projectId));
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
      persistDeploySelection: async () => {},
      // Compose+materialize stub: every greenfield derive composes a
      // fragment-based template; the stub returns a fixture seed without
      // touching GitHub. Overridable per test.
      materializeTemplate: () => stubMaterialize(),
      // ds-composer — production ALWAYS wires this (mountFeatureRoutes) and the
      // derive now fails loud on its absence, so the shared helper supplies a no-op
      // by default (the real producer is covered by its own integration suite). A
      // caller may override it, e.g. to inject a `DesignFragmentAuthoringFailedError`.
      composeDesignSystem: () => async () => {},
      ...onboardingOverrides,
      bootstrapProject,
    }),
  );
  app.route(
    "/orgs",
    createProjectRoutes({
      pool: pool.asPgPool(),
      secrets,
      githubHttp,
      githubAppMinter,
      bootstrapProject,
      ...(preflightDeploy === undefined
        ? {}
        : {
            greenfieldPreflightDeploy: async (input) => {
              // The project deploy preflight is only ever invoked with a deploy
              // provider kind (the state machine forwards `deploy.providerKind`).
              // The shared `GreenfieldProviderKind` input widened to include
              // `"slack"` for the notify seam, so narrow before bridging to the
              // deploy-only onboarding callback.
              if (input.providerKind === "slack") return undefined;
              return preflightDeploy({
                orgId: input.orgId,
                providerKind: input.providerKind,
                ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
                ...(input.grantId === undefined ? {} : { grantId: input.grantId }),
              });
            },
          }),
      ...(preflightNotify === undefined ? {} : { greenfieldPreflightNotify: preflightNotify }),
      ...(prepareDeploy === undefined
        ? {}
        : {
            greenfieldPrepareDeploy: async (input) =>
              prepareDeploy({
                orgId: input.orgId,
                projectId: input.projectId,
                capability: "deploy",
                providerKind: input.deploy.providerKind,
                mode: input.deploy.mode,
                projectKey: input.projectKey,
                projectName: input.projectName,
                ...(input.deploy.connectionId === undefined ? {} : { connectionId: input.deploy.connectionId }),
                ...(input.deploy.grantId === undefined ? {} : { grantId: input.deploy.grantId }),
                ...(input.deploy.chosenResourceId === undefined
                  ? {}
                  : { chosenResourceId: input.deploy.chosenResourceId }),
                ...(input.deploy.stack === undefined ? {} : { stack: input.deploy.stack }),
                ...(input.deploy.name === undefined ? {} : { name: input.deploy.name }),
              }),
          }),
      ...(prepareNotify === undefined ? {} : { greenfieldPrepareNotify: prepareNotify }),
    }),
  );
  // `githubHttp` is the repo-create transport fake; its `createdRepositories` is the
  // assertable record of what the route created (the pre-decomposition tests asserted
  // on `vcsProvider.createdRepositories`).
  return { app, githubHttp, onboardingStateSecrets: secrets };
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
      authority: {
        connectionId: "connection_1",
        grantId: "grant_1",
        providerPrincipalId: "account_1",
        authGeneration: 1,
        grantGeneration: 1,
      },
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
  personas: ["operator"],
  behaviors: ["operator::inspect status"],
  dimensions: [],
};

// A COMPLETE capture (rv-21 completion predicate) except with NO deploy — isolates the
// deploy-guard rejection so it passes the completeness gate + the missing-lifecycle /
// missing-design-contract guards and reaches the deploy guard under test.
export const captureWithLifecycle = () => ({
  ...emptyCapture(),
  ...completeCaptureExtras(),
  lifecycle: GREENFIELD_TS_LIFECYCLE,
  designContract: GREENFIELD_DESIGN_CONTRACT,
});

export function apexCapture() {
  return {
    ...emptyCapture(),
    ...completeCaptureExtras(),
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

export class LinkedDeployRoutesPool extends RoutesPool {
  override async query(sql: string, params: unknown[] = []) {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    // Inventory for listExactControlGrants (never a lease).
    if (
      text.includes("FROM org_integration_connections c") &&
      text.includes("LEFT JOIN org_integration_grants g") &&
      text.includes("display_name")
    ) {
      const orgId = String(params[0]);
      return {
        rows: [
          {
            connection_id: "connection_1",
            grant_id: "grant_1",
            org_id: orgId,
            provider_kind: "deploy.vercel",
            provider_principal_id: "account_1",
            principal_kind: "team",
            display_name: "account_1",
            health: "healthy",
            connection_status: "active",
            current_auth_generation: 1,
            grant_generation: 1,
            grant_status: "active",
            auth_expires_at: null,
            provider_scopes: [],
            operation_id: null,
            operation_stage: null,
            operation_status: null,
            selected_for_project: false,
          },
        ],
        rowCount: 1,
      };
    }
    // authorizeOperation eligibility — selected generations match.
    if (text.includes("FROM org_integration_connections c") && text.includes("project_integration_grant_selections")) {
      return {
        rows: [
          {
            connection_id: "connection_1",
            provider_kind: "deploy.vercel",
            provider_principal_id: "account_1",
            display_name: "account_1",
            principal_metadata: {},
            connection_health: "healthy",
            connection_status: "active",
            current_auth_generation: 1,
            grant_id: "grant_1",
            grant_current_generation: 1,
            grant_status: "active",
            plane: "control",
            environment: "control",
            credential_ref: "secret://missing/deploy-token/g/1",
            auth_expires_at: null,
            auth_status: "active",
            capabilities: ["deploy"],
            operations: ["discover", "provision", "bind"],
            provider_scopes: [],
            resource_constraints: {},
            policy_revision: "integration-catalog.v3",
            consent_revision: "consent.test",
            grant_expires_at: null,
            grant_generation_status: "active",
            selected_auth_generation: 1,
            selected_grant_generation: 1,
            selected_connection_id: "connection_1",
            selected_grant_id: "grant_1",
          },
        ],
        rowCount: 1,
      };
    }
    // selectControlGrant persistence for greenfield project selection.
    if (text.includes("INSERT INTO project_integration_grant_selections")) {
      return {
        rows: [
          {
            connection_id: "connection_1",
            grant_id: "grant_1",
            auth_generation: 1,
            grant_generation: 1,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("SELECT provider_principal_id FROM org_integration_connections")) {
      return { rows: [{ provider_principal_id: "account_1" }], rowCount: 1 };
    }
    return super.query(sql, params);
  }
}
