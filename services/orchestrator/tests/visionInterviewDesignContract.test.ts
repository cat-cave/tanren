// Native design subsystem (WS-D1) — the LOUD guards on the derive's design-contract
// authoring cluster (integration-review P1 + P2): a missing captured design contract
// is a LOUD halt (never a silent no-op of the whole design subsystem), and a dangling
// moat ref on the thin-capture seam is a LOUD halt (consistent with the design phase +
// design oracle), never a silent drop that shrinks the coverage obligation.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  DanglingDesignRefError,
  deriveFromCapture,
  emptyCapture,
  MissingDesignContractError,
  runRound,
  type CaptureLifecycle,
  type InterviewCapture,
} from "../src/engine/forge/interview/index.js";
import type { MaterializeTemplate } from "../src/engine/templates/index.js";
import { createDeterministicInterviewAnswerer } from "./fixtures/forge/deterministicInterviewAnswerer.js";
import {
  preparedDeploy,
  stubPool,
  noopComposeDesignSystem,
  successfulBootstrapProject,
} from "./fixtures/forge/interviewDeriveStub.js";

// PR-G (task #77) — opaque composed-template identifier; no GitHub repo at this ref.
const stubMaterialize = (): MaterializeTemplate => async (input) => ({
  templateRef: `tanren://composed/${input.config.slug}@deadbeefcafe1234`,
  validatedAt: "2026-06-09T00:00:00.000Z",
});

const TS_LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};

// A minimal, EXPLICIT design contract — an explicit, design-light contract is valid;
// a SILENT absence is not.
const MINIMAL_DESIGN_CONTRACT = {
  domain: "saas-web",
  identity: "a clean, trustworthy operations surface",
  intent: "a calm, information-dense control surface an operator trusts at a glance",
  principles: [],
  constraints: [],
  personas: [],
  behaviors: [],
  dimensions: [],
};

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const TEST_REPO_URL = "https://github.com/cat-cave/supply-chain-os";

// A capture WITH a lifecycle (so the earlier missing-lifecycle guard does not fire) but
// a NULL design contract — the missing-design-contract guard under test.
const lifecycleOnlyCapture = (): InterviewCapture => ({
  ...emptyCapture(),
  lifecycle: TS_LIFECYCLE,
  designContract: null,
});

describe("deriveProductGraph · the required design contract (no silent no-op)", () => {
  it("FAILS LOUD when the design step captured no design contract (no silent design-subsystem no-op)", async () => {
    const { pool, state } = stubPool();
    // A deploy provider + a matching template are supplied, so neither of THOSE guards is
    // what fires — the rejection is specifically the MISSING DESIGN CONTRACT. A null
    // contract would otherwise silently no-op the whole design subsystem (no contract
    // row, no writer design block, the oracle no-ops) with no signal.
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy(request) {
            return preparedDeploy(request.providerKind as "deploy.vercel" | "deploy.flyio");
          },
        },
        {
          orgId: "org_a",
          capture: lifecycleOnlyCapture(),
          actor,
          repoUrl: TEST_REPO_URL,
          owner: "cat-cave",
          deploy: { providerKind: "deploy.vercel" },
          materializeTemplate: stubMaterialize(),
        },
      ),
    ).rejects.toBeInstanceOf(MissingDesignContractError);
    // The guard runs at the derive boundary (before any external resource), so no
    // project is created.
    expect(state.projects.size).toBe(0);
  });

  it("the explicit minimal contract (a design-light project) is ACCEPTED — presence, not web dimensions, is the requirement", async () => {
    // The requirement is an EXPLICIT contract, not web-heavy dimensions. A minimal one
    // (domain + identity + intent, empty principles/constraints/dimensions) derives
    // successfully and persists a real design contract row.
    const { pool, state } = stubPool();
    const derived = await deriveFromCapture(
      {
        pool,
        async prepareDeploy(request) {
          return preparedDeploy(request.providerKind as "deploy.vercel" | "deploy.flyio");
        },
      },
      {
        orgId: "org_a",
        capture: { ...emptyCapture(), lifecycle: TS_LIFECYCLE, designContract: MINIMAL_DESIGN_CONTRACT },
        actor,
        repoUrl: TEST_REPO_URL,
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
        materializeTemplate: stubMaterialize(),
        bootstrapProject: successfulBootstrapProject,
        composeDesignSystem: noopComposeDesignSystem,
      },
    );
    expect(derived.designContract.id).toBeDefined();
    expect(derived.designContract.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(state.designContracts).toHaveLength(1);
  });

  it("FAILS LOUD on a dangling design moat ref (thin-capture seam — consistent with the design phase + oracle)", async () => {
    // The agent-less thin-capture path persists the captured contract verbatim, binding
    // its persona/behavior refs to the PERSISTED entity ids. A captured ref resolving to
    // no real entity is a LOUD `DanglingDesignRefError` (NOT a silent drop that shrinks
    // the coverage obligation the oracle assumes exhaustive) — the same loud posture as
    // `designPhase.ts` + the design oracle. Here the contract names a persona the
    // interview never captured.
    const { pool, state } = stubPool();
    const answerer = createDeterministicInterviewAnswerer();
    let capture: InterviewCapture = emptyCapture();
    let complete = false;
    for (let round = 1; round <= 20 && !complete; round += 1) {
      const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
      capture = result.capture;
      complete = result.complete;
    }
    const tampered: InterviewCapture = {
      ...capture,
      designContract:
        capture.designContract === null
          ? capture.designContract
          : { ...capture.designContract, personas: [...capture.designContract.personas, "phantom analyst"] },
    };
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy(request) {
            return preparedDeploy(request.providerKind as "deploy.vercel" | "deploy.flyio");
          },
        },
        {
          orgId: "org_a",
          capture: tampered,
          actor,
          repoUrl: TEST_REPO_URL,
          owner: "cat-cave",
          deploy: { providerKind: "deploy.vercel" },
          materializeTemplate: stubMaterialize(),
        },
      ),
    ).rejects.toBeInstanceOf(DanglingDesignRefError);
    // The loud halt means no design contract row is persisted (the whole derive throws).
    expect(state.designContracts).toHaveLength(0);
  });
});
