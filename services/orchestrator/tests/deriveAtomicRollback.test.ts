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
  deploysProvisioned: Array<{ providerKind: string; appId: string }>;
  deploysDestroyed: Array<{ providerKind: string; appId: string }>;
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

function preparedFlyDeploy(): PreparedGreenfieldDeploy {
  return {
    outcome: {
      status: "provisioned",
      capability: "deploy",
      providerKind: "deploy.flyio",
      action: "provision",
      mode: "greenfield",
      secretRefNames: ["secret://deploy/deploy.flyio/org_a-linkly/token"],
      surfaces: {
        projectConfigKeys: ["deployProvider", "deployAppId"],
        deployRef: "deploy.flyio:org_a-linkly",
      },
    },
    projectConfig: {
      deployProvider: "deploy.flyio",
      deployAppId: "org_a-linkly",
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
          rec.deploysProvisioned.push({ providerKind: "deploy.flyio", appId: "org_a-linkly" });
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

  it("ROLLBACK ON DEPLOY FAILURE: project repo created → DELETED on rollback (only resource to undo)", async () => {
    // SCENARIO: project repo created (registered) + compose pushed VFS into it
    // + prepareDeploy THROWS. The compensation stack walks LIFO: only the
    // project repo needs deletion (no separate seed repo to roll back per PR-G).
    const { pool, state } = stubPool();
    const rec = newRecorder();
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy() {
            // The deploy provision fails — simulates a Fly quota exceeded or a
            // transient provisioner error after the project repo was created.
            throw new Error("simulated: deploy provision quota exceeded");
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
      ),
    ).rejects.toThrow(/deploy provision quota exceeded/iu);

    // ONE project repo created, ONE deleted. No `tanren-tmpl-*` was ever created.
    expect(rec.reposCreated).toEqual([{ owner: "cat-cave", name: "linkly" }]);
    expect(rec.reposDeleted).toEqual([{ owner: "cat-cave", name: "linkly" }]);
    expect(rec.pushedRepos).toEqual(["cat-cave/linkly"]);
    // The deploy provision threw — no deploy app was ever created.
    expect(rec.deploysProvisioned).toEqual([]);
    expect(rec.deploysDestroyed).toEqual([]);
    expect(state.projects.size).toBe(0);
  });

  it("ROLLBACK ON CREATE-PROJECT FAILURE: both external resources walked back (project repo + deploy)", async () => {
    // SCENARIO: every external resource provisions successfully, then the
    // `createProject` DB INSERT throws (e.g. a uniqueness violation). The
    // compensation stack walks LIFO: deploy app destroyed, then project repo
    // deleted. Per PR-G there are exactly TWO external resources, not three.
    const { pool, state } = stubPool();
    // Inject a stub that throws on the project INSERT (the durable-row anchor).
    type SqlQuery = (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    const originalConnect = pool.connect.bind(pool);
    (pool as unknown as { connect: () => Promise<{ query: SqlQuery; release: () => void }> }).connect = async () => {
      const client = await originalConnect();
      const originalClientQuery = client.query.bind(client) as SqlQuery;
      return {
        query: async (text: string, params: unknown[] = []) => {
          const sql = text.replaceAll(/\s+/gu, " ").trim();
          if (sql.startsWith("INSERT INTO projects")) {
            throw new Error("simulated: duplicate key value violates projects_pkey");
          }
          return originalClientQuery(text, params);
        },
        release: client.release,
      };
    };

    const rec = newRecorder();
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy() {
            rec.deploysProvisioned.push({ providerKind: "deploy.flyio", appId: "org_a-linkly" });
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
      ),
    ).rejects.toThrow(/duplicate key value violates projects_pkey/iu);

    // ONE project repo + ONE deploy app rolled back (LIFO: deploy first, then repo).
    expect(rec.reposCreated).toEqual([{ owner: "cat-cave", name: "linkly" }]);
    expect(rec.deploysProvisioned).toEqual([{ providerKind: "deploy.flyio", appId: "org_a-linkly" }]);
    expect(rec.deploysDestroyed).toEqual([{ providerKind: "deploy.flyio", appId: "org_a-linkly" }]);
    expect(rec.reposDeleted).toEqual([{ owner: "cat-cave", name: "linkly" }]);
    expect(state.projects.size).toBe(0);
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
          rec.deploysProvisioned.push({ providerKind: "deploy.flyio", appId: "org_a-linkly" });
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
