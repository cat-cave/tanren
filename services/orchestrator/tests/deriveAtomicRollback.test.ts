// DERIVE TRANSACTIONAL ROLLBACK — task #78. Proves the greenfield derive is
// ATOMIC across its external-resource creates (the materialized seed repo +
// the project repo + the provisioned deploy app). When a step LATER in the
// derive throws, every external resource created so far in the same call is
// rolled back BEFORE the original error re-raises — so the operator's next
// retry never collides on an orphan (apex v62: `cat-cave/linkly` was hand-
// deleted to get past a 422 on the template repo create).
//
// The doctrine:
//   1. Compose+materialize succeeds → seed repo created → register compensation.
//   2. resolveOrCreateGreenfieldRepo succeeds → project repo created → register.
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

// A seeded fixture template the stub materializer returns: the `repoRef` is the
// `<owner>/<name>` slug a real materialize would have just created on GitHub.
const SEED: SeededTemplate = {
  templateRef: "tanren://composed/ts-pnpm@abc1234",
  repoRef: "cat-cave/tanren-tmpl-ts-pnpm",
  validatedAt: "2026-06-09T00:00:00.000Z",
  validatedSha: "abc1234",
};

interface RecordedCreates {
  reposCreated: Array<{ owner: string; name: string }>;
  reposDeleted: Array<{ owner: string; name: string }>;
  deploysProvisioned: Array<{ providerKind: string; appId: string }>;
  deploysDestroyed: Array<{ providerKind: string; appId: string }>;
}

function newRecorder(): RecordedCreates {
  return { reposCreated: [], reposDeleted: [], deploysProvisioned: [], deploysDestroyed: [] };
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

// A stub materialize that records the seed repo it minted (so the test can
// assert the rollback deletes it) but does NOT touch any HTTP — the
// production materializer would call CodeHost.createRepo + push files.
function recordingMaterialize(recorder: RecordedCreates): MaterializeTemplate {
  return async () => {
    const [owner, name] = SEED.repoRef.split("/", 2);
    if (owner !== undefined && name !== undefined) {
      recorder.reposCreated.push({ owner, name });
    }
    return SEED;
  };
}

describe("derive — TRANSACTIONAL ROLLBACK across external resources (task #78)", () => {
  it("ROLLBACK ON PROJECT-REPO CREATE FAILURE: seed repo was materialized → deleted on rollback", async () => {
    // SCENARIO: the seed repo is materialized (registered), then the project-repo
    // create THROWS (a 422-equivalent surfaced as a generic create failure for
    // the test). The compensation stack walks LIFO and deletes the seed repo
    // before the original error re-raises.
    const { pool, state } = stubPool();
    const rec = newRecorder();
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
          materializeTemplate: recordingMaterialize(rec),
          createRepository: async () => {
            // The project-repo create fails — simulates a generic create failure
            // (e.g. transient network) after the seed repo was already materialized.
            throw new Error("simulated: project repo create transient failure");
          },
          deleteRepository: async (target) => {
            rec.reposDeleted.push(target);
          },
          destroyDeployApp: async (target) => {
            rec.deploysDestroyed.push(target);
          },
        },
      ),
    ).rejects.toThrow(/project repo create transient failure/iu);

    // The seed repo was materialized + then deleted by the rollback. NO project
    // repo was created (the create threw before producing one), so nothing else
    // to roll back.
    expect(rec.reposCreated).toEqual([{ owner: "cat-cave", name: "tanren-tmpl-ts-pnpm" }]);
    expect(rec.reposDeleted).toEqual([{ owner: "cat-cave", name: "tanren-tmpl-ts-pnpm" }]);
    expect(rec.deploysProvisioned).toEqual([]);
    expect(rec.deploysDestroyed).toEqual([]);
    // No project row landed — we never reached createProject.
    expect(state.projects.size).toBe(0);
  });

  it("ROLLBACK ON DEPLOY FAILURE: seed + project repos created → BOTH deleted on rollback", async () => {
    // SCENARIO: seed materialized (registered) + project repo created
    // (registered) + prepareDeploy THROWS. The compensation stack walks LIFO:
    // the project repo is deleted first, then the seed repo. Apex v62 in
    // miniature: the operator never has to hand-delete `cat-cave/linkly`.
    const { pool, state } = stubPool();
    const rec = newRecorder();
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy() {
            // The deploy provision fails — simulates a Fly quota exceeded or a
            // transient provisioner error after BOTH repos were created.
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

    // BOTH repos created, BOTH deleted (LIFO: project repo first, then seed repo).
    expect(rec.reposCreated).toEqual([
      { owner: "cat-cave", name: "tanren-tmpl-ts-pnpm" },
      { owner: "cat-cave", name: "linkly" },
    ]);
    expect(rec.reposDeleted).toEqual([
      { owner: "cat-cave", name: "linkly" },
      { owner: "cat-cave", name: "tanren-tmpl-ts-pnpm" },
    ]);
    // The deploy provision threw — no deploy app was ever created.
    expect(rec.deploysProvisioned).toEqual([]);
    expect(rec.deploysDestroyed).toEqual([]);
    expect(state.projects.size).toBe(0);
  });

  it("ROLLBACK ON CREATE-PROJECT FAILURE: ALL three external resources walked back", async () => {
    // SCENARIO: every external resource provisions successfully, then the
    // `createProject` DB INSERT throws (e.g. a uniqueness violation). The
    // compensation stack walks LIFO: deploy app destroyed, then project repo
    // deleted, then seed repo deleted.
    const { pool, state } = stubPool();
    // Inject a stub that throws on the project INSERT (the durable-row anchor) —
    // this fails the createProject TRANSACTION inside the connected client (which
    // is the path `createProject` uses, not the bare `pool.query`).
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

    // ALL three external creates rolled back, in reverse order.
    expect(rec.reposCreated).toEqual([
      { owner: "cat-cave", name: "tanren-tmpl-ts-pnpm" },
      { owner: "cat-cave", name: "linkly" },
    ]);
    expect(rec.deploysProvisioned).toEqual([{ providerKind: "deploy.flyio", appId: "org_a-linkly" }]);
    // LIFO walk: deploy app first, then project repo, then seed repo.
    expect(rec.deploysDestroyed).toEqual([{ providerKind: "deploy.flyio", appId: "org_a-linkly" }]);
    expect(rec.reposDeleted).toEqual([
      { owner: "cat-cave", name: "linkly" },
      { owner: "cat-cave", name: "tanren-tmpl-ts-pnpm" },
    ]);
    expect(state.projects.size).toBe(0);
  });

  it("DeriveRollbackError SURFACES rollback gaps: failed compensation rides on the error", async () => {
    // SCENARIO: the seed repo was materialized + the project-repo create throws.
    // The rollback walker tries to delete the seed repo but THAT delete ALSO
    // throws (e.g. the credential lost administration:write between create +
    // rollback). The original failure is preserved on `cause`; the rollback gap
    // names the specific resource that may be orphaned (the seed repo).
    const { pool } = stubPool();
    const rec = newRecorder();
    let caught: unknown;
    try {
      await deriveFromCapture(
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
          materializeTemplate: recordingMaterialize(rec),
          createRepository: async () => {
            throw new Error("simulated: project repo create failure");
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
    expect((rb.cause as Error).message).toMatch(/project repo create failure/iu);
    // The rollback gap names the orphaned resource specifically.
    expect(rb.compensationFailures).toHaveLength(1);
    expect(rb.compensationFailures[0]?.kind).toBe("github.repo");
    expect(rb.compensationFailures[0]?.label).toBe("cat-cave/tanren-tmpl-ts-pnpm");
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
