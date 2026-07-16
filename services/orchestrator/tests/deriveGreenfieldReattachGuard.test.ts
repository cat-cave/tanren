// Repository reuse is ownership-marker based. A name collision is never enough
// to adopt an existing repository into a derivation.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  type CaptureLifecycle,
  type InterviewCapture,
  type PreparedGreenfieldDeploy,
} from "../src/engine/forge/interview/index.js";
import { RepositoryAlreadyExistsError } from "../src/engine/contracts/codeHostTypes.js";
import type { MaterializeTemplate, SeededTemplate } from "../src/engine/templates/index.js";
import { stubPool, successfulBootstrapProject } from "./fixtures/forge/interviewDeriveStub.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const TS_LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};

const MINIMAL_DESIGN_CONTRACT = {
  domain: "saas-web",
  identity: "an operations surface",
  intent: "calm + dense control surface",
  principles: [],
  constraints: [],
  personas: [],
  behaviors: [],
  dimensions: [],
};

const captureWithLifecycle = (): InterviewCapture => ({
  ...emptyCapture(),
  identity: { slug: "linkly", pitch: "A short link service.", repoHint: "" },
  lifecycle: TS_LIFECYCLE,
  designContract: MINIMAL_DESIGN_CONTRACT,
});

const SEED: SeededTemplate = {
  templateRef: "tanren://composed/ts-pnpm@deadbeefcafe1234",
  validatedAt: "2026-06-09T00:00:00.000Z",
};

function preparedFlyDeploy(): PreparedGreenfieldDeploy {
  return {
    outcome: {
      status: "provisioned",
      capability: "deploy",
      providerKind: "deploy.flyio",
      action: "provision",
      mode: "greenfield",
      authority: {
        connectionId: "connection_1",
        grantId: "grant_1",
        providerPrincipalId: "account_1",
        authGeneration: 1,
        grantGeneration: 1,
      },
      secretRefNames: ["secret://deploy/deploy.flyio/fly_app_42/token"],
      surfaces: {
        projectConfigKeys: ["deployProvider", "deployAppId", "deployAppName"],
        deployRef: "deploy.flyio:fly_app_42",
      },
    },
    projectConfig: {
      deployProvider: "deploy.flyio",
      deployAppId: "fly_app_42",
      deployAppName: "org_a-linkly",
    },
  };
}

const materialize: MaterializeTemplate = async () => SEED;

const createRepositoryAlreadyExists = async (input: { owner: string; name: string }): Promise<never> => {
  throw new RepositoryAlreadyExistsError(input.owner, input.name);
};

describe("derive — greenfield repository ownership", () => {
  it("rejects an unrelated same-name repository without adopting it", async () => {
    const { pool, state } = stubPool();
    let materialized = false;
    let deployPrepared = false;
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy() {
            deployPrepared = true;
            return preparedFlyDeploy();
          },
        },
        {
          orgId: "org_a",
          capture: captureWithLifecycle(),
          actor,
          owner: "cat-cave",
          deploy: { providerKind: "deploy.flyio" },
          materializeTemplate: async (...args) => {
            materialized = true;
            return materialize(...args);
          },
          bootstrapProject: successfulBootstrapProject,
          createRepository: createRepositoryAlreadyExists,
        },
      ),
    ).rejects.toBeInstanceOf(RepositoryAlreadyExistsError);

    expect(state.projects.size).toBe(1);
    expect(materialized).toBe(false);
    expect(deployPrepared).toBe(false);
  });
});
