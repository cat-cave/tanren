// ds-composer — the Piece-4 WIRING proof: `deriveProductGraph` invokes the
// `composeDesignSystem` seam once the HEAD design contract exists (after the graph
// step, before bootstrap). This is what makes ds-3's F2D loop reachable in production
// — without this call the producer (and F2D) would stay a dead path. Drives the real
// `deriveFromCapture` over the in-memory stub pool with a SPY seam and asserts it fired
// scoped to the newly-derived project.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  type CaptureLifecycle,
  type InterviewCapture,
  type PreparedGreenfieldDeploy,
} from "../src/engine/forge/interview/index.js";
import type { MaterializeTemplate, SeededTemplate } from "../src/engine/templates/index.js";
import { stubPool, successfulBootstrapProject } from "./fixtures/forge/interviewDeriveStub.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const TEST_REPO_URL = "https://github.com/cat-cave/linkly.git";

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
const materialize: MaterializeTemplate = async () => SEED;

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
    projectConfig: { deployProvider: "deploy.flyio", deployAppId: "fly_app_42", deployAppName: "org_a-linkly" },
  };
}

describe("derive — ds-composer seam wiring", () => {
  it("invokes composeDesignSystem once, scoped to the derived project (F2D is reachable, not dead)", async () => {
    const { pool } = stubPool();
    const calls: Array<{ orgId: string; projectId: string }> = [];
    const derived = await deriveFromCapture(
      {
        pool,
        async prepareDeploy() {
          return preparedFlyDeploy();
        },
      },
      {
        orgId: "org_a",
        capture: captureWithLifecycle(),
        actor,
        repoUrl: TEST_REPO_URL,
        owner: "cat-cave",
        deploy: { providerKind: "deploy.flyio" },
        materializeTemplate: materialize,
        bootstrapProject: successfulBootstrapProject,
        composeDesignSystem: async (input) => {
          calls.push(input);
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.orgId).toBe("org_a");
    expect(calls[0]?.projectId).toBe(derived.projectId);
  });
});
