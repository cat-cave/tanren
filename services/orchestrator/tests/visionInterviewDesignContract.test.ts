// Native design subsystem (WS-D1) — the LOUD guards on the derive's design-contract
// authoring cluster (integration-review P1 + P2): a missing captured design contract
// is a LOUD halt (never a silent no-op of the whole design subsystem), and a dangling
// moat ref on the thin-capture seam is a LOUD halt (consistent with the design phase +
// design oracle), never a silent drop that shrinks the coverage obligation.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  InterviewIncompleteError,
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
import { completeCaptureExtras } from "./fixtures/forge/completeCapture.js";

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

// A COMPLETE capture (rv-21) EXCEPT a NULL design contract — isolates the missing
// design-seed area so the unified completion gate reports exactly `designSeed`.
const designSeedOnlyMissing = (): InterviewCapture => ({
  ...emptyCapture(),
  ...completeCaptureExtras(),
  lifecycle: TS_LIFECYCLE,
  designContract: null,
});

describe("deriveProductGraph · the required design contract (no silent no-op)", () => {
  it("FAILS LOUD (unified interview-incomplete) when the design step captured no design contract (no silent design-subsystem no-op)", async () => {
    const { pool, state } = stubPool();
    // A deploy provider + a matching template are supplied, so neither of THOSE guards is
    // what fires — the rv-21 completion gate rejects the MISSING DESIGN SEED. A null
    // contract would otherwise silently no-op the whole design subsystem (no contract
    // row, no writer design block, the oracle no-ops) with no signal.
    const error = await deriveFromCapture(
      {
        pool,
        async prepareDeploy(request) {
          return preparedDeploy(request.providerKind as "deploy.vercel" | "deploy.flyio");
        },
      },
      {
        orgId: "org_a",
        capture: designSeedOnlyMissing(),
        actor,
        repoUrl: TEST_REPO_URL,
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
        materializeTemplate: stubMaterialize(),
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InterviewIncompleteError);
    expect((error as InterviewIncompleteError).missing).toEqual(["designSeed"]);
    // The guard runs at the derive boundary (before any external resource), so no
    // project is created.
    expect(state.projects.size).toBe(0);
  });

  it("the explicit minimal contract (a design-light project) is ACCEPTED — presence, not web dimensions, is the requirement", async () => {
    // The requirement is an EXPLICIT contract, not web-heavy dimensions. A minimal one
    // (domain + identity + intent, empty principles/constraints/dimensions) on an
    // otherwise-complete capture derives successfully and persists a real contract row.
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
        capture: {
          ...emptyCapture(),
          ...completeCaptureExtras(),
          lifecycle: TS_LIFECYCLE,
          designContract: MINIMAL_DESIGN_CONTRACT,
        },
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

  it("FAILS LOUD (unified interview-incomplete) on a dangling design moat ref (no captured reference silently dropped)", async () => {
    // The design seed's persona/behavior refs are vetted against the captured graph at
    // the boundary. A ref resolving to no captured entity is a LOUD halt (NOT a silent
    // drop that shrinks the coverage obligation the oracle assumes exhaustive) — here the
    // contract names a persona the interview never captured.
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
    const error = await deriveFromCapture(
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
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InterviewIncompleteError);
    expect((error as InterviewIncompleteError).invalid).toContainEqual(
      expect.objectContaining({ kind: "designPersona", ref: "phantom analyst" }),
    );
    // The loud halt means no design contract row is persisted (the whole derive throws).
    expect(state.designContracts).toHaveLength(0);
  });
});
