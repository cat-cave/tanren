import { defaultOrgConfigV1 } from "../src/engine/config/orgConfig.js";
import { defaultProjectConfigV1 } from "../src/engine/config/projectConfig.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { EagerBeamFactsResolver } from "../src/engine/merge/eagerBeamFacts.js";
import { EagerBeamMaterializationPersistence } from "../src/engine/merge/eagerBeamMaterializationPersistence.js";
import { EagerBeamPlanStager, type StagedEagerBeamPlan } from "../src/engine/merge/eagerBeamPlanStager.js";
import {
  type EagerBeamCandidate,
  type EagerBeamProject,
  PgEagerBeamStore,
} from "../src/engine/merge/eagerBeamStore.js";
import type { MaterializedIntegrationNodeRecord } from "../src/engine/merge/integrationNodeMaterializer.js";
import { LOCAL_HANDLE } from "./conformance/fakes/localCommandSubstrate.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueEagerBeamRoutes } from "../src/routes/mergeQueue/eagerBeams.js";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";

const BASE_SHA = "a".repeat(40);
const ANCESTOR_SHA = "b".repeat(40);
const FRONTIER_SHA = "c".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}`;

class EmptyCiConfigSubstrate implements CommandSubstrate {
  public async run(_target: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class EagerBeamPool {
  public readonly events: string[] = [];
  public readyRowCount = 1;
  public routeRows: unknown[] = [];
  private cas: { digest: string; mediaType: string; bytes: Buffer } | undefined;

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("event_type, payload)")) {
      const eventType = params[5];
      if (typeof eventType === "string") this.events.push(eventType);
    }
    if (sql.includes("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_eager" }], rowCount: 1 };
    if (sql.includes("SELECT p.repo_url")) {
      return {
        rows: [
          {
            repo_url: "https://github.com/owner/repo.git",
            default_branch: "main",
            runner_image: "runner@sha256:test",
            project_config: projectConfig(),
            org_config: defaultOrgConfigV1(),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM merge_queue q")) {
      return { rows: [candidate()], rowCount: 1 };
    }
    if (sql.includes("FROM merge_eager_beams b")) return { rows: this.routeRows, rowCount: this.routeRows.length };
    if (sql.includes("INSERT INTO integration_nodes")) return { rows: [{ node_id: "node_eager" }], rowCount: 1 };
    if (sql.includes("INSERT INTO cas_artifacts")) {
      const digest = params[1];
      const mediaType = params[3];
      const bytes = params[4];
      if (typeof digest === "string" && typeof mediaType === "string" && Buffer.isBuffer(bytes)) {
        this.cas = { digest, mediaType, bytes };
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT byte_size, media_type, inline_bytes")) {
      return this.cas === undefined
        ? { rows: [], rowCount: 0 }
        : {
            rows: [
              { byte_size: this.cas.bytes.byteLength, media_type: this.cas.mediaType, inline_bytes: this.cas.bytes },
            ],
            rowCount: 1,
          };
    }
    if (sql.includes("SET state = 'ready'")) return { rows: [], rowCount: this.readyRowCount };
    if (sql.includes("SET state = 'stale'")) {
      return {
        rows: [{ id: "beam_prior", frontier_run_id: "run_frontier", plan_digest: DIGEST }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO merge_eager_beams")) {
      return { rows: [{ id: "beam_eager", generation: 1 }], rowCount: 1 };
    }
    if (sql.includes("FROM integration_proof_units")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE integration_nodes")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }

  public asPgPool(): never {
    return this as never;
  }
}

class RefHttp {
  public constructor(private readonly refs: ReadonlyMap<string, string>) {}

  public async request(input: { path: string }): Promise<{ status: number; body: unknown }> {
    const encoded = input.path.split("/heads/")[1];
    const branch = encoded === undefined ? "" : decodeURIComponent(encoded);
    const sha = this.refs.get(branch);
    return sha === undefined ? { status: 404, body: {} } : { status: 200, body: { object: { sha } } };
  }
}

function project(): EagerBeamProject {
  return {
    orgId: "org_eager",
    projectId: "project_eager",
    repoUrl: "https://github.com/owner/repo.git",
    defaultBranch: "main",
    runnerImage: "runner@sha256:test",
    projectConfig: projectConfig(),
    orgConfig: defaultOrgConfigV1(),
  };
}

function projectConfig() {
  return { ...defaultProjectConfigV1(), credentials: { githubCredentialRef: "token" } };
}

function candidate(): EagerBeamCandidate {
  return {
    runId: "run_frontier",
    specId: "spec_frontier",
    branch: "feature/frontier",
    ancestorStack: [
      { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: ANCESTOR_SHA },
    ],
    priority: "P0",
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}

async function factsResolver(pool: EagerBeamPool, refs: ReadonlyMap<string, string>): Promise<EagerBeamFactsResolver> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/github/org/org_eager/token", value: "eager-token" });
  return new EagerBeamFactsResolver({
    pool: pool.asPgPool(),
    secrets,
    githubHttp: new RefHttp(refs),
  });
}

function stagedPlan(): StagedEagerBeamPlan {
  return {
    plan: {
      version: 1,
      schemaVersion: "eager_beam.v1",
      beamWidth: 1,
      rank: 1,
      orgId: "org_eager",
      projectId: "project_eager",
      frontierRunId: "run_frontier",
      frontierSpecId: "spec_frontier",
      baseBranch: "main",
      baseSha: BASE_SHA,
      ancestorStack: [],
      frontier: { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: FRONTIER_SHA },
      members: [{ specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: FRONTIER_SHA }],
      expectedMemberKey: "f".repeat(64),
      proofReuseInput: {
        memberKey: "f".repeat(64),
        gateConfigHash: "d".repeat(64),
        policyVersion: "1",
        runnerImage: "runner@sha256:test",
        appEnvHash: "e".repeat(64),
        quarantineVersion: "none",
      },
    },
    planDigest: DIGEST,
    proofReuseInput: {
      memberKey: "f".repeat(64),
      gateConfigHash: "d".repeat(64),
      policyVersion: "1",
      runnerImage: "runner@sha256:test",
      appEnvHash: "e".repeat(64),
      quarantineVersion: "none",
    },
  };
}

describe("EAGER production fact gathering", () => {
  it("uses the real published ancestor heads, exact ordered members, and quarantine facts", async () => {
    const pool = new EagerBeamPool();
    const resolver = await factsResolver(
      pool,
      new Map([
        ["main", BASE_SHA],
        ["feature/ancestor", ANCESTOR_SHA],
        ["feature/frontier", FRONTIER_SHA],
      ]),
    );

    const result = await resolver.resolve(project(), candidate());
    if (result.kind !== "resolved") throw new Error(`expected resolved facts, received ${result.reason}`);
    expect(result.facts.baseSha).toBe(BASE_SHA);
    expect(result.facts.members.map((member) => member.headSha)).toEqual([ANCESTOR_SHA, FRONTIER_SHA]);
    expect(result.facts.memberKey).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("holds rather than building when the ancestor publication no longer matches its durable stack", async () => {
    const pool = new EagerBeamPool();
    const resolver = await factsResolver(
      pool,
      new Map([
        ["main", BASE_SHA],
        ["feature/ancestor", "d".repeat(40)],
      ]),
    );

    await expect(resolver.resolve(project(), candidate())).resolves.toEqual({
      kind: "held",
      reason: "ancestor_head_changed",
    });
    await expect(resolver.resolve(project(), { ...candidate(), ancestorStack: [] })).resolves.toEqual({
      kind: "held",
      reason: "empty_ancestor_stack",
    });
  });
});

describe("EAGER proof-plan staging", () => {
  it("freezes a CAS plan before persistence and records an exact proof-unit evaluation", async () => {
    const pool = new EagerBeamPool();
    const stager = new EagerBeamPlanStager({ pool: pool.asPgPool(), ssh: new EmptyCiConfigSubstrate() });
    const facts = {
      repoUrl: "https://github.com/owner/repo.git",
      baseBranch: "main",
      baseSha: BASE_SHA,
      members: [
        { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: ANCESTOR_SHA },
        { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: FRONTIER_SHA },
      ],
      memberKey: "f".repeat(64),
      runnerImage: "runner@sha256:test",
      policyVersion: "1",
      quarantineVersion: "none",
      appEnv: {},
      installation: undefined,
      staticRef: "token",
    };
    const staged = await stager.stage({
      beamWidth: 1,
      rank: 1,
      orgId: "org_eager",
      projectId: "project_eager",
      frontierRunId: "run_frontier",
      frontierSpecId: "spec_frontier",
      facts,
      gateInput: { target: LOCAL_HANDLE, workspacePath: "/workspace" },
    });

    expect(staged.planDigest).toMatch(/^sha256:/u);
    expect(staged.plan.members.map((member) => member.headSha)).toEqual([ANCESTOR_SHA, FRONTIER_SHA]);
    await stager.evaluateMaterialization({
      orgId: "org_eager",
      projectId: "project_eager",
      nodeId: "node_eager",
      staged,
    });
    expect(pool.events).toContain("integration.proof_root.composed");
  });

  it("rejects a blank live proof coordinate instead of staging a reusable plan", async () => {
    const pool = new EagerBeamPool();
    const stager = new EagerBeamPlanStager({ pool: pool.asPgPool(), ssh: new EmptyCiConfigSubstrate() });
    await expect(
      stager.stage({
        beamWidth: 1,
        rank: 1,
        orgId: "org_eager",
        projectId: "project_eager",
        frontierRunId: "run_frontier",
        frontierSpecId: "spec_frontier",
        facts: { ...(await resolvedFacts()), runnerImage: " " },
        gateInput: { target: LOCAL_HANDLE, workspacePath: "/workspace" },
      }),
    ).rejects.toThrow("unresolved");
  });
});

describe("EAGER beam durable transitions", () => {
  it("loads scoped candidates, invalidates stale evidence, records a held row, and CAS-marks ready", async () => {
    const pool = new EagerBeamPool();
    const store = new PgEagerBeamStore(pool.asPgPool());
    const loadedProject = await store.loadProject("project_eager");
    expect(loadedProject?.orgId).toBe("org_eager");
    expect(await store.loadCandidates(loadedProject!)).toHaveLength(1);

    await store.hold({
      orgId: "org_eager",
      projectId: "project_eager",
      frontierRunId: "run_frontier",
      frontierSpecId: "spec_frontier",
      rank: 1,
      reason: "ancestor_head_changed",
    });
    expect(pool.events).toEqual(expect.arrayContaining(["merge.beam.stale", "integration.proof.invalidated"]));

    const persisted = await store.persistMaterialized({
      record: {
        orgId: "org_eager",
        projectId: "project_eager",
        baseBranch: "main",
        baseSha: BASE_SHA,
        ref: "tanren-local-eager",
        purpose: "eager_beam",
        members: [],
        memberKey: "f".repeat(64),
        headSha: FRONTIER_SHA,
        treeHash: "tree",
        status: "building",
      },
      plan: stagedPlan().plan,
      planDigest: DIGEST,
    });
    expect(persisted).toEqual({ nodeId: "node_eager", beamId: "beam_eager", generation: 1 });

    await expect(
      store.markReady({
        orgId: "org_eager",
        projectId: "project_eager",
        planDigest: DIGEST,
        nodeId: "node_eager",
      }),
    ).resolves.toBeUndefined();
    pool.readyRowCount = 0;
    await expect(
      store.markReady({
        orgId: "org_eager",
        projectId: "project_eager",
        planDigest: DIGEST,
        nodeId: "node_eager",
      }),
    ).rejects.toThrow("lost its exact building coordinate");
    await store.recordMaterializationFailure({
      orgId: "org_eager",
      projectId: "project_eager",
      runId: "run_frontier",
      specId: "spec_frontier",
      memberKey: "f".repeat(64),
      baseSha: BASE_SHA,
      failureCode: "jj_conflict",
      diagnosticsDigest: DIGEST,
    });
    expect(pool.events).toContain("integration.node.materialization_failed");
  });
});

describe("EAGER beam read projection", () => {
  it("returns exact evidence only for a complete, typed integration node and marks malformed evidence unavailable", async () => {
    const pool = new EagerBeamPool();
    pool.routeRows = [
      {
        id: "beam_eager",
        frontier_run_id: "run_frontier",
        frontier_spec_id: "spec_frontier",
        plan_digest: DIGEST,
        integration_node_id: "node_eager",
        rank: 1,
        generation: 1,
        state: "ready",
        stale_reason: null,
        updated_at: new Date("2026-07-20T00:00:00.000Z"),
        base_sha: BASE_SHA,
        members: [
          { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: FRONTIER_SHA },
        ],
        node_status: "ready",
        proof_root: DIGEST,
      },
    ];
    const app = eagerBeamApp(pool, platformActor());
    const exact = await app.request("/org_eager/projects/project_eager/merge-queue/eager-beams");
    expect(exact.status).toBe(200);
    await expect(exact.json()).resolves.toMatchObject({ beams: [{ evidenceState: "exact", baseSha: BASE_SHA }] });

    pool.routeRows = [{ ...pool.routeRows[0]!, base_sha: "not-a-sha" }];
    const unavailable = await app.request("/org_eager/projects/project_eager/merge-queue/eager-beams");
    await expect(unavailable.json()).resolves.toMatchObject({ beams: [{ evidenceState: "unavailable" }] });
  });

  it("does not reveal the projection to an actor outside the addressed org", async () => {
    const app = eagerBeamApp(new EagerBeamPool(), {
      userId: "user_other",
      orgId: "org_other",
      projectId: null,
      scopes: ["org:member"],
      source: "local_dev",
    });
    const response = await app.request("/org_eager/projects/project_eager/merge-queue/eager-beams");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "eager_beams_not_found" });
  });
});

describe("EAGER materialization persistence", () => {
  it("requires a frozen plan for node persistence and retains a typed failure", async () => {
    const store = new RecordingBeamStore();
    const persistence = new EagerBeamMaterializationPersistence(store, candidate(), 1, () => stagedPlan());
    const record: MaterializedIntegrationNodeRecord = {
      orgId: "org_eager",
      projectId: "project_eager",
      baseBranch: "main",
      baseSha: BASE_SHA,
      ref: "tanren-local-eager",
      purpose: "eager_beam",
      members: [],
      memberKey: "f".repeat(64),
      headSha: FRONTIER_SHA,
      treeHash: "tree",
      status: "building",
    };
    await expect(persistence.persistMaterialized(record)).resolves.toBe("node_eager");
    await persistence.recordMaterializationFailure({
      orgId: "org_eager",
      projectId: "project_eager",
      memberKey: "f".repeat(64),
      baseSha: BASE_SHA,
      failureCode: "jj_conflict",
      diagnosticsDigest: DIGEST,
    });
    expect(store.held).toBe(1);
    expect(store.failed).toBe(1);
  });
});

async function resolvedFacts() {
  const resolver = await factsResolver(
    new EagerBeamPool(),
    new Map([
      ["main", BASE_SHA],
      ["feature/ancestor", ANCESTOR_SHA],
      ["feature/frontier", FRONTIER_SHA],
    ]),
  );
  const result = await resolver.resolve(project(), candidate());
  if (result.kind !== "resolved") throw new Error("test facts must resolve");
  return result.facts;
}

function platformActor(): ActorContext {
  return {
    userId: "user_admin",
    orgId: null,
    projectId: null,
    scopes: ["platform:admin"],
    source: "local_dev",
  };
}

function eagerBeamApp(pool: EagerBeamPool, actor: ActorContext): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", createMergeQueueEagerBeamRoutes({ pool: pool.asPgPool() }));
  return app;
}

class RecordingBeamStore extends PgEagerBeamStore {
  public held = 0;
  public failed = 0;

  public constructor() {
    super(new EagerBeamPool().asPgPool());
  }

  public override async persistMaterialized(): Promise<{ nodeId: string; beamId: string; generation: number }> {
    return { nodeId: "node_eager", beamId: "beam_eager", generation: 1 };
  }

  public override async hold(): Promise<void> {
    this.held += 1;
  }

  public override async recordMaterializationFailure(): Promise<void> {
    this.failed += 1;
  }
}
