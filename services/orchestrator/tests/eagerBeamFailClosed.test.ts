import { describe, expect, it } from "vitest";
import { defaultProjectConfigV1 } from "../src/engine/config/projectConfig.js";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { createEagerBeamPlan, eagerBeamPlanV1Schema } from "../src/engine/contracts/eagerBeamPlan.js";
import { EagerBeamFactsResolver } from "../src/engine/merge/eagerBeamFacts.js";
import { type EagerBeamCandidate, type EagerBeamProject } from "../src/engine/merge/eagerBeamStore.js";
import {
  EagerIntegrationBeamPlanner,
  selectEagerBeamCandidates,
} from "../src/engine/merge/eagerIntegrationBeamPlanner.js";
import { IntegrationNodeMaterializer } from "../src/engine/merge/integrationNodeMaterializer.js";
import { createInMemoryIntegrationNodeMaterializationStore } from "./conformance/fakes/inMemoryMergeQueue.js";
import { InMemoryWorkspaceVcsCore } from "./conformance/fakes/inMemoryWorkspaceVcsCore.js";

const BASE_SHA = "a".repeat(40);
const ANCESTOR_SHA = "b".repeat(40);
const FRONTIER_SHA = "c".repeat(40);

class EmptyCommandSubstrate implements CommandSubstrate {
  public async run(_target: never, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class RefHttp {
  public constructor(private readonly refs: ReadonlyMap<string, string>) {}

  public async request(input: { path: string }): Promise<{ status: number; body: unknown }> {
    const encoded = input.path.split("/heads/")[1];
    const branch = encoded === undefined ? "" : decodeURIComponent(encoded);
    const sha = this.refs.get(branch);
    return sha === undefined
      ? { status: 404, body: {} }
      : { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha } } };
  }
}

class BeamUnitPool {
  public readonly heldReasons: string[] = [];

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_eager" }], rowCount: 1 };
    if (sql.includes("SELECT p.repo_url")) {
      return {
        rows: [
          {
            repo_url: "https://github.com/owner/repo.git",
            default_branch: "main",
            runner_image: "runner@sha256:test",
            project_config: projectConfig(),
            org_config: undefined,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM merge_queue q")) {
      return {
        rows: [
          {
            run_id: "run_frontier",
            spec_id: "spec_frontier",
            branch: "feature/frontier",
            ancestor_stack: [],
            priority: "P0",
            created_at: "2026-07-20T00:00:00.000Z",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO merge_eager_beams")) {
      const reason = params[6];
      if (typeof reason === "string") this.heldReasons.push(reason);
      return { rows: [{ id: "beam_held" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }

  public asPgPool(): never {
    return this as never;
  }
}

function project(overrides: Partial<EagerBeamProject> = {}): EagerBeamProject {
  return {
    orgId: "org_eager",
    projectId: "project_eager",
    repoUrl: "https://github.com/owner/repo.git",
    defaultBranch: "main",
    runnerImage: "runner@sha256:test",
    projectConfig: projectConfig(),
    orgConfig: undefined,
    ...overrides,
  };
}

function projectConfig() {
  return { ...defaultProjectConfigV1(), credentials: { githubCredentialRef: "token" } };
}

function candidate(overrides: Partial<EagerBeamCandidate> = {}): EagerBeamCandidate {
  return {
    runId: "run_frontier",
    specId: "spec_frontier",
    branch: "feature/frontier",
    ancestorStack: [
      { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: ANCESTOR_SHA },
    ],
    priority: "P0",
    createdAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

async function factsResolver(refs: ReadonlyMap<string, string>): Promise<EagerBeamFactsResolver> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/github/org/org_eager/token", value: "eager-token" });
  return new EagerBeamFactsResolver({
    pool: new BeamUnitPool().asPgPool(),
    secrets,
    githubHttp: new RefHttp(refs),
  });
}

function plan() {
  return createEagerBeamPlan({
    beamWidth: 3,
    rank: 1,
    orgId: "org_eager",
    projectId: "project_eager",
    frontierRunId: "run_frontier",
    frontierSpecId: "spec_frontier",
    baseBranch: "main",
    baseSha: BASE_SHA,
    ancestorStack: [
      { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: ANCESTOR_SHA },
    ],
    frontier: { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: FRONTIER_SHA },
    proofReuseInput: {
      memberKey: "0".repeat(64),
      gateConfigHash: "d".repeat(64),
      policyVersion: "policy.v1",
      runnerImage: "runner@sha256:test",
      appEnvHash: "e".repeat(64),
      quarantineVersion: "none",
    },
  });
}

function materializationInput() {
  return {
    orgId: "org_eager",
    projectId: "project_eager",
    repoUrl: "https://github.com/owner/repo.git",
    baseBranch: "main",
    baseSha: BASE_SHA,
    members: [
      { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: ANCESTOR_SHA },
      { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: FRONTIER_SHA },
    ],
    localRef: "tanren-local-eager-unit",
    workspacePath: "/scratch/eager",
    purpose: "eager_beam" as const,
  };
}

describe("EAGER beam pure admission", () => {
  it("sorts the deterministic top-K through every allow-listed priority and rejects malformed ranking inputs", () => {
    const selected = selectEagerBeamCandidates(
      [
        candidate({ runId: "run_tbd", specId: "spec_tbd", priority: "tbd", createdAt: "2026-01-04T00:00:00.000Z" }),
        candidate({ runId: "run_p2", specId: "spec_p2", priority: "P2", createdAt: "2026-01-03T00:00:00.000Z" }),
        candidate({
          runId: "run_z",
          specId: "spec_same",
          priority: "P0",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
        candidate({ runId: "run_a", specId: "spec_same", priority: "P0", createdAt: "2026-01-01T00:00:00.000Z" }),
        candidate({ runId: "run_p1", specId: "spec_p1", priority: "P1", createdAt: "2026-01-02T00:00:00.000Z" }),
      ],
      4,
    );

    expect(selected.map(({ runId }) => runId)).toEqual(["run_a", "run_z", "run_p1", "run_p2"]);
    expect(() => selectEagerBeamCandidates([candidate(), candidate({ priority: "P3" })], 1)).toThrow(
      "invalid priority",
    );
    expect(() => selectEagerBeamCandidates([candidate(), candidate({ createdAt: " " })], 1)).toThrow(
      "invalid creation order",
    );
    expect(() => selectEagerBeamCandidates([candidate(), candidate({ createdAt: new Date("invalid") })], 1)).toThrow(
      "invalid creation order",
    );
    expect(() => selectEagerBeamCandidates([candidate()], 0)).toThrow("positive integer");
  });

  it("rejects incomplete or altered frozen coordinates instead of admitting reusable evidence", () => {
    const value = plan();
    const invalidPlans = [
      { ...value, baseSha: "a".repeat(39) },
      { ...value, members: [{ ...value.members[0], headSha: "B".repeat(40) }, value.members[1]] },
      { ...value, expectedMemberKey: "f".repeat(64) },
      { ...value, proofReuseInput: { ...value.proofReuseInput, memberKey: "f".repeat(64) } },
      { ...value, members: [...value.members.slice(0, 1), { ...value.members[1], runId: "run_other" }] },
      { ...value, ancestorStack: [{ ...value.ancestorStack[0], branch: "feature/other" }] },
      { ...value, score: 100 },
    ];

    for (const invalid of invalidPlans) expect(eagerBeamPlanV1Schema.safeParse(invalid).success).toBe(false);
  });
});

describe("EAGER beam fact resolution", () => {
  it("holds on an empty, malformed, or stale ancestor stack before any build can start", async () => {
    const resolver = await factsResolver(
      new Map([
        ["main", BASE_SHA],
        ["feature/ancestor", "d".repeat(40)],
      ]),
    );

    await expect(resolver.resolve(project(), candidate({ ancestorStack: [] }))).resolves.toEqual({
      kind: "held",
      reason: "empty_ancestor_stack",
    });
    await expect(
      resolver.resolve(project(), candidate({ ancestorStack: [{ specId: "missing-head" }] })),
    ).rejects.toThrow("ancestor_stack failed schema parse");
    await expect(
      resolver.resolve(project({ repoUrl: "https://github.com/owner/repo-stale.git" }), candidate()),
    ).resolves.toEqual({ kind: "held", reason: "ancestor_head_changed" });
  });

  it("rejects incomplete input and every non-full published SHA with typed holds", async () => {
    await expect(
      (await factsResolver(new Map([["main", "a".repeat(39)]]))).resolve(
        project({ repoUrl: "https://github.com/owner/repo-base-invalid.git" }),
        candidate(),
      ),
    ).resolves.toEqual({ kind: "held", reason: "base_head_unavailable" });
    await expect(
      (
        await factsResolver(
          new Map([
            ["main", BASE_SHA],
            ["feature/ancestor", "B".repeat(40)],
          ]),
        )
      ).resolve(project({ repoUrl: "https://github.com/owner/repo-ancestor-invalid.git" }), candidate()),
    ).resolves.toEqual({ kind: "held", reason: "ancestor_head_unavailable" });
    await expect(
      (
        await factsResolver(
          new Map([
            ["main", BASE_SHA],
            ["feature/ancestor", ANCESTOR_SHA],
          ]),
        )
      ).resolve(project({ repoUrl: "https://github.com/owner/repo-frontier-invalid.git" }), candidate()),
    ).resolves.toEqual({ kind: "held", reason: "frontier_head_unavailable" });
    await expect((await factsResolver(new Map())).resolve(project(), candidate({ branch: " " }))).rejects.toThrow(
      "frontier branch is missing or blank",
    );
  });

  it("uses the canonical runner image only after every exact ref is confirmed", async () => {
    const resolver = await factsResolver(
      new Map([
        ["main", BASE_SHA],
        ["feature/ancestor", ANCESTOR_SHA],
        ["feature/frontier", FRONTIER_SHA],
      ]),
    );

    const result = await resolver.resolve(
      project({ repoUrl: "https://github.com/owner/repo-default-image.git", runnerImage: null }),
      candidate(),
    );
    expect(result).toMatchObject({ kind: "resolved", facts: { baseSha: BASE_SHA, runnerImage: expect.any(String) } });
  });
});

describe("EAGER materialization verification", () => {
  it("records base and member movement as failures without persisting an integration node", async () => {
    const baseMovedWorkspace = new InMemoryWorkspaceVcsCore();
    baseMovedWorkspace.seedRemoteRef("main", "d".repeat(40));
    baseMovedWorkspace.seedRemoteRef("feature/ancestor", ANCESTOR_SHA);
    baseMovedWorkspace.seedRemoteRef("feature/frontier", FRONTIER_SHA);
    const baseMovedStore = createInMemoryIntegrationNodeMaterializationStore();

    await expect(
      new IntegrationNodeMaterializer(baseMovedWorkspace, baseMovedStore).materialize(materializationInput()),
    ).resolves.toMatchObject({ kind: "failed", failureCode: "base_sha_moved" });
    expect(baseMovedStore.nodes).toEqual([]);
    expect(baseMovedStore.events).toEqual([
      expect.objectContaining({
        type: "integration.node.materialization_failed",
        failure: expect.objectContaining({ failureCode: "base_sha_moved" }),
      }),
    ]);

    const memberMovedWorkspace = new InMemoryWorkspaceVcsCore();
    memberMovedWorkspace.seedRemoteRef("main", BASE_SHA);
    memberMovedWorkspace.seedRemoteRef("feature/ancestor", "d".repeat(40));
    memberMovedWorkspace.seedRemoteRef("feature/frontier", FRONTIER_SHA);
    const memberMovedStore = createInMemoryIntegrationNodeMaterializationStore();

    await expect(
      new IntegrationNodeMaterializer(memberMovedWorkspace, memberMovedStore).materialize(materializationInput()),
    ).resolves.toMatchObject({ kind: "failed", failureCode: "member_head_moved" });
    expect(memberMovedStore.nodes).toEqual([]);
    expect(memberMovedStore.events).toEqual([
      expect.objectContaining({
        type: "integration.node.materialization_failed",
        failure: expect.objectContaining({ failureCode: "member_head_moved" }),
      }),
    ]);
  });
});

describe("EAGER planner fail closed", () => {
  it("durably holds an empty stack through the advisory planner without allocating a workspace", async () => {
    const pool = new BeamUnitPool();
    const planner = new EagerIntegrationBeamPlanner({
      pool: pool.asPgPool(),
      secrets: new InMemorySecretStore(),
      githubHttp: new RefHttp(new Map()),
      allocator: new FakeAllocator(),
      ssh: new EmptyCommandSubstrate(),
      identitySecretRef: "identity/eager",
    });

    await planner.planAndBuild("project_eager");
    expect(pool.heldReasons).toEqual(["empty_ancestor_stack"]);
  });
});
