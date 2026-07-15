// GREENFIELD RE-ATTACH GUARD (apex v84). Proves the derive fails LOUD when it would
// re-attach to a repo that already carries a PRIOR run's compose history — and still
// re-attaches cleanly to the stranded, empty auto_init seed the idempotency intends.
//
// ROOT CAUSE this pins: on `RepositoryAlreadyExistsError` (the repo exists + no
// project bound) the derive used to UNCONDITIONALLY re-attach. If the existing repo
// was a prior apex run's scaffold (full of `tanren compose:` history), the new run
// pushed its compose commits on top, causing a cross-run BASE DIVERGENCE that later
// failed "prepare clean PR branch" with an opaque `WorkspaceCommandError`. The guard
// gates the re-attach on a repo-emptiness probe: bare auto_init ⇒ re-attach; already
// carrying content ⇒ `GreenfieldRepoNotEmptyError` (a clean 409 upstream). The
// clean-PR-prep base model itself is SOUND on a clean repo and is untouched.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  type CaptureLifecycle,
  type InterviewCapture,
  type PreparedGreenfieldDeploy,
} from "../src/engine/forge/interview/index.js";
import { GreenfieldRepoNotEmptyError, RepositoryAlreadyExistsError } from "../src/engine/contracts/codeHostTypes.js";
import type { MaterializeTemplate, SeededTemplate } from "../src/engine/templates/index.js";
import { stubPool } from "./fixtures/forge/interviewDeriveStub.js";

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
        upstreamAccountId: "account_1",
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

// A createRepository that always signals "the repo already exists" — the re-attach
// branch the guard governs. (No project row is bound, so the derive reaches the branch.)
const createRepositoryAlreadyExists = async (input: { owner: string; name: string }): Promise<never> => {
  throw new RepositoryAlreadyExistsError(input.owner, input.name);
};

describe("derive — GREENFIELD RE-ATTACH GUARD (apex v84)", () => {
  it("RE-ATTACHES to a BARE auto_init repo (the stranded-empty case) and completes the derive", async () => {
    const { pool, state } = stubPool();
    const result = await deriveFromCapture(
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
        owner: "cat-cave",
        deploy: { providerKind: "deploy.flyio" },
        materializeTemplate: materialize,
        createRepository: createRepositoryAlreadyExists,
        deleteRepository: async () => {},
        destroyDeployApp: async () => {},
        // BARE: the repo is the stranded, empty auto_init seed → re-attach is safe.
        probeRepoBareAutoInit: async () => true,
      },
    );
    // The derive completed on the re-attached repo (the deterministic clone url).
    expect(result.repository?.repoUrl).toBe("https://github.com/cat-cave/linkly.git");
    expect(state.projects.size).toBe(1);
  });

  it("FAILS LOUD (GreenfieldRepoNotEmptyError) on a repo already carrying prior compose history", async () => {
    const { pool, state } = stubPool();
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
          materializeTemplate: materialize,
          createRepository: createRepositoryAlreadyExists,
          deleteRepository: async () => {},
          destroyDeployApp: async () => {},
          // CONTAMINATED: the repo already carries a prior run's compose history → reject.
          probeRepoBareAutoInit: async () => false,
        },
      ),
    ).rejects.toBeInstanceOf(GreenfieldRepoNotEmptyError);

    // The guard fires BEFORE any downstream resource work — no project row, no deploy.
    expect(state.projects.size).toBe(0);
    expect(deployPrepared).toBe(false);
  });

  it("re-attach with NO probe wired is a loud WIRING BUG (never a silent unguarded reuse)", async () => {
    const { pool } = stubPool();
    await expect(
      deriveFromCapture(
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
          owner: "cat-cave",
          deploy: { providerKind: "deploy.flyio" },
          materializeTemplate: materialize,
          createRepository: createRepositoryAlreadyExists,
          deleteRepository: async () => {},
          destroyDeployApp: async () => {},
          // No probeRepoBareAutoInit wired.
        },
      ),
    ).rejects.toThrow(/repo-emptiness probe/iu);
  });
});
