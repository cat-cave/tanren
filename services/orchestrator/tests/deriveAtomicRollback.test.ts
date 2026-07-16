// DERIVE TRANSACTIONAL ROLLBACK — task #78. Proves the greenfield derive is
// ATOMIC across its external-resource creates (the project repo + the
// provisioned deploy app). When a step LATER in the derive throws, every
// external resource created so far in the same call is rolled back BEFORE the
// original error re-raises — so the operator's next retry never collides on
// an orphan.
//
// PR-G (task #77) collapsed the intermediate `tanren-tmpl-<slug>` template
// seed repo: the composed VFS is pushed DIRECTLY into the project repo as its
// initial content. So there are now TWO external resources to rollback (the
// project repo + the deploy app), not three (no separate seed repo).
//
// The doctrine:
//   1. resolveOrCreateGreenfieldRepo succeeds → project repo created → register.
//   2. Compose+materialize pushes the VFS into the project repo (no separate
//      compensation — a failure here is covered by the project-repo rollback).
//   3. prepareDeploy succeeds → deploy app provisioned → register.
//   4. If ANYTHING after a successful compensation registration throws (deploy
//      provisioning fails, createProject DB constraint, etc.), the compensation
//      stack walks LIFO + every resource is deleted before re-raising.
//
// We assert at the BOUNDARY: the test injects fake `createRepository`/
// `deleteRepository`/`prepareDeploy`/`destroyDeployApp` callbacks that record
// every invocation; after a forced failure the recorded delete/destroy calls
// must MATCH the recorded create/provision calls one-for-one.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  DeriveRollbackError,
  emptyCapture,
  type CaptureLifecycle,
  type InterviewCapture,
  type PreparedGreenfieldDeploy,
} from "../src/engine/forge/interview/index.js";
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

// PR-G — opaque templateRef (no GitHub repo at this ref).
const SEED: SeededTemplate = {
  templateRef: "tanren://composed/ts-pnpm@deadbeefcafe1234",
  validatedAt: "2026-06-09T00:00:00.000Z",
};

interface RecordedCreates {
  reposCreated: Array<{ owner: string; name: string }>;
  reposDeleted: Array<{ owner: string; name: string }>;
  pushedRepos: string[];
  deploysProvisioned: Array<{ providerKind: string; appId: string; appName: string }>;
  deploysDestroyed: Array<{
    providerKind: string;
    appId: string;
    appName: string;
    connectionId: string;
    grantId: string;
    projectId?: string;
  }>;
}

function newRecorder(): RecordedCreates {
  return {
    reposCreated: [],
    reposDeleted: [],
    pushedRepos: [],
    deploysProvisioned: [],
    deploysDestroyed: [],
  };
}

// PRODUCTION SHAPE (audit finding D4): Fly's `listApps` returns
// `appId: app.id ?? app.name` — typically the DISTINCT internal id (e.g.
// `fly_app_42`), while the user-visible globally-unique name is the destroy-path
// key. The prior fixture set `deployAppId === deployAppName`, masking the
// regression entirely. Distinct values here reproduce the live shape.
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

// PR-G: a stub materialize that records the project repo it pushed into. The
// real materializer would call `pushFile` once per composed VFS entry against
// the same project repo's HTTPS clone URL.
function recordingMaterialize(recorder: RecordedCreates): MaterializeTemplate {
  return async (input) => {
    recorder.pushedRepos.push(input.projectRepo.fullName);
    return SEED;
  };
}

describe("derive — TRANSACTIONAL ROLLBACK across external resources (task #78, PR-G)", () => {
  it("NO INTERMEDIATE TEMPLATE REPO: the materializer pushes into the just-created project repo", async () => {
    const { pool, state } = stubPool();
    const rec = newRecorder();
    await deriveFromCapture(
      {
        pool,
        async prepareDeploy() {
          rec.deploysProvisioned.push({
            providerKind: "deploy.flyio",
            appId: "fly_app_42",
            appName: "org_a-linkly",
          });
          return preparedFlyDeploy();
        },
      },
      {
        orgId: "org_a",
        capture: captureWithLifecycle(),
        actor,
        owner: "cat-cave",
        deploy: { providerKind: "deploy.flyio" },
        materializeTemplate: recordingMaterialize(rec),
        createRepository: async (input) => {
          rec.reposCreated.push({ owner: input.owner, name: input.name });
          return {
            fullName: `${input.owner}/${input.name}`,
            repoUrl: `https://github.com/${input.owner}/${input.name}`,
            defaultBranch: "main",
          };
        },
        deleteRepository: async (target) => {
          rec.reposDeleted.push(target);
        },
        destroyDeployApp: async (target) => {
          rec.deploysDestroyed.push(target);
        },
      },
    );
    // EXACTLY ONE repo was created — the project repo itself. No `tanren-tmpl-*`
    // intermediate repo was created at any point.
    expect(rec.reposCreated).toEqual([{ owner: "cat-cave", name: "linkly" }]);
    for (const created of rec.reposCreated) {
      expect(created.name).not.toMatch(/^tanren-tmpl-/u);
    }
    // The materializer pushed INTO the project repo.
    expect(rec.pushedRepos).toEqual(["cat-cave/linkly"]);
    // Success path — no rollbacks fired.
    expect(rec.reposDeleted).toEqual([]);
    expect(rec.deploysDestroyed).toEqual([]);
    expect(state.projects.size).toBe(1);
  });

  it("ROLLBACK ON DEPLOY FAILURE: project repo created → DELETED on rollback (project shell may remain)", async () => {
    // SCENARIO: project repo created + project shell (selection anchor) + prepareDeploy
    // THROWS. Compensation deletes the project repo; deploy never provisioned.
    const { pool } = stubPool();
    const rec = newRecorder();
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy() {
            throw new Error("simulated: deploy provision quota exceeded");
          },
        },
        {
          orgId: "org_a",
          capture: captureWithLifecycle(),
          actor,
          owner: "cat-cave",
          deploy: { providerKind: "deploy.flyio", connectionId: "connection_1", grantId: "grant_1" },
          materializeTemplate: recordingMaterialize(rec),
          createRepository: async (input) => {
            rec.reposCreated.push({ owner: input.owner, name: input.name });
            return {
              fullName: `${input.owner}/${input.name}`,
              repoUrl: `https://github.com/${input.owner}/${input.name}`,
              defaultBranch: "main",
            };
          },
          deleteRepository: async (target) => {
            rec.reposDeleted.push(target);
          },
          destroyDeployApp: async (target) => {
            rec.deploysDestroyed.push(target);
          },
        },
      ),
    ).rejects.toThrow(/deploy provision quota exceeded/iu);

    expect(rec.reposCreated).toEqual([{ owner: "cat-cave", name: "linkly" }]);
    expect(rec.reposDeleted).toEqual([{ owner: "cat-cave", name: "linkly" }]);
    expect(rec.pushedRepos).toEqual(["cat-cave/linkly"]);
    expect(rec.deploysProvisioned).toEqual([]);
    expect(rec.deploysDestroyed).toEqual([]);
  });

  it("ROLLBACK ON POST-DEPLOY FAILURE: both external resources walked back (project repo + deploy)", async () => {
    // SCENARIO: project shell + deploy provision succeed, then entity-graph INSERT
    // throws. Compensation destroys deploy app then project repo.
    const { pool } = stubPool();
    const originalQuery = pool.query.bind(pool) as (
      text: string,
      params?: unknown[],
    ) => Promise<{ rows: unknown[]; rowCount: number }>;
    let deployDone = false;
    const wrappedQuery = async (text: string, params: unknown[] = []) => {
      const sql = text.replaceAll(/\s+/gu, " ").trim();
      if (deployDone && sql.startsWith("INSERT INTO specs")) {
        throw new Error("simulated: entity graph materialization failed");
      }
      return originalQuery(text, params);
    };
    (pool as unknown as { query: typeof wrappedQuery }).query = wrappedQuery;
    (pool as unknown as { connect: () => Promise<{ query: typeof wrappedQuery; release: () => void }> }).connect =
      async () => ({ query: wrappedQuery, release() {} });

    const rec = newRecorder();
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy() {
            rec.deploysProvisioned.push({
              providerKind: "deploy.flyio",
              appId: "fly_app_42",
              appName: "org_a-linkly",
            });
            deployDone = true;
            return preparedFlyDeploy();
          },
        },
        {
          orgId: "org_a",
          capture: captureWithLifecycle(),
          actor,
          owner: "cat-cave",
          deploy: { providerKind: "deploy.flyio", connectionId: "connection_1", grantId: "grant_1" },
          materializeTemplate: recordingMaterialize(rec),
          createRepository: async (input) => {
            rec.reposCreated.push({ owner: input.owner, name: input.name });
            return {
              fullName: `${input.owner}/${input.name}`,
              repoUrl: `https://github.com/${input.owner}/${input.name}`,
              defaultBranch: "main",
            };
          },
          deleteRepository: async (target) => {
            rec.reposDeleted.push(target);
          },
          destroyDeployApp: async (target) => {
            rec.deploysDestroyed.push(target);
          },
        },
      ),
    ).rejects.toThrow(/entity graph materialization failed/iu);

    expect(rec.reposCreated).toEqual([{ owner: "cat-cave", name: "linkly" }]);
    expect(rec.deploysProvisioned).toEqual([
      { providerKind: "deploy.flyio", appId: "fly_app_42", appName: "org_a-linkly" },
    ]);
    expect(rec.deploysDestroyed).toEqual([
      {
        providerKind: "deploy.flyio",
        appId: "fly_app_42",
        appName: "org_a-linkly",
        connectionId: "connection_1",
        grantId: "grant_1",
        projectId: expect.any(String),
      },
    ]);
    expect(rec.reposDeleted).toEqual([{ owner: "cat-cave", name: "linkly" }]);
  });

  it("DeriveRollbackError SURFACES rollback gaps: failed compensation rides on the error", async () => {
    // SCENARIO: the project repo was created + the deploy prepare throws. The
    // rollback walker tries to delete the project repo but THAT delete ALSO
    // throws (e.g. the credential lost administration:write between create +
    // rollback). The original failure is preserved on `cause`; the rollback gap
    // names the specific resource that may be orphaned (the project repo).
    const { pool } = stubPool();
    const rec = newRecorder();
    let caught: unknown;
    try {
      await deriveFromCapture(
        {
          pool,
          async prepareDeploy() {
            throw new Error("simulated: deploy provision failure");
          },
        },
        {
          orgId: "org_a",
          capture: captureWithLifecycle(),
          actor,
          owner: "cat-cave",
          deploy: { providerKind: "deploy.flyio" },
          materializeTemplate: recordingMaterialize(rec),
          createRepository: async (input) => {
            rec.reposCreated.push({ owner: input.owner, name: input.name });
            return {
              fullName: `${input.owner}/${input.name}`,
              repoUrl: `https://github.com/${input.owner}/${input.name}`,
              defaultBranch: "main",
            };
          },
          deleteRepository: async () => {
            throw new Error("simulated: delete forbidden — credential lacks administration:write");
          },
          destroyDeployApp: async () => {},
        },
      );
    } catch (error) {
      caught = error;
    }
    // The thrown error is a DeriveRollbackError carrying the rollback gap.
    expect(caught).toBeInstanceOf(DeriveRollbackError);
    const rb = caught as DeriveRollbackError;
    // The ORIGINAL failure rides on `cause` — the operator sees both.
    expect(rb.cause).toBeInstanceOf(Error);
    expect((rb.cause as Error).message).toMatch(/deploy provision failure/iu);
    // The rollback gap names the orphaned PROJECT repo specifically (no
    // `tanren-tmpl-*` because the intermediate template repo doesn't exist).
    expect(rb.compensationFailures).toHaveLength(1);
    expect(rb.compensationFailures[0]?.kind).toBe("github.repo");
    expect(rb.compensationFailures[0]?.label).toBe("cat-cave/linkly");
  });

  it("NO ROLLBACK ON SUCCESS: external resources stay intact when derive lands the project row", async () => {
    // SCENARIO: the happy path — every external create succeeds, createProject
    // succeeds, entity graph is built. NO rollback fires; the resources are
    // durable + linked to the project row.
    const { pool, state } = stubPool();
    const rec = newRecorder();
    const result = await deriveFromCapture(
      {
        pool,
        async prepareDeploy() {
          rec.deploysProvisioned.push({
            providerKind: "deploy.flyio",
            appId: "fly_app_42",
            appName: "org_a-linkly",
          });
          return preparedFlyDeploy();
        },
      },
      {
        orgId: "org_a",
        capture: captureWithLifecycle(),
        actor,
        owner: "cat-cave",
        deploy: { providerKind: "deploy.flyio" },
        materializeTemplate: recordingMaterialize(rec),
        createRepository: async (input) => {
          rec.reposCreated.push({ owner: input.owner, name: input.name });
          return {
            fullName: `${input.owner}/${input.name}`,
            repoUrl: `https://github.com/${input.owner}/${input.name}`,
            defaultBranch: "main",
          };
        },
        deleteRepository: async (target) => {
          rec.reposDeleted.push(target);
        },
        destroyDeployApp: async (target) => {
          rec.deploysDestroyed.push(target);
        },
      },
    );
    expect(result.projectName).toBe("linkly");
    expect(state.projects.size).toBe(1);
    // NO rollback fired — the resources stand.
    expect(rec.reposDeleted).toEqual([]);
    expect(rec.deploysDestroyed).toEqual([]);
  });
});
