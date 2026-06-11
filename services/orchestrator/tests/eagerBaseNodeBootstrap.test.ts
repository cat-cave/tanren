// WS-A PR-8 (walker-jj-local-integration-design.md §2.3, §6 fork F4) — the dependent
// jj-local bootstrap, on a CLEAN assembly, OBSERVE-ONLY UPSERTs an `eager_base`
// integration node into the SAME proof-reuse substrate the batch path's `merge_batch`
// node uses. Two layers:
//
//   PURE / WIRING layer (always-on, runs in `just fast-check`): drive `prepareRunWorkspace`
//   with the flag ON + a non-empty stack + an injected fake `eagerBaseNodeUpsert`, and pin
//   the UPSERT facts — `purpose: eager_base` (fork F4), the ORDERED members
//   `{specId, runId, branch, headSha}` (DAG order, zipped with the per-ancestor assembly
//   shas), `ref` = the LOCAL assembly bookmark, the assembled head/tree. Plus: a node-write
//   FAILURE never breaks the run (observe-only); a null-org run skips the write; the legacy
//   clone path writes NO node.
//
//   DB layer (gated behind TANREN_RLS_DB_TEST=1 + an owner DATABASE_URL, like the other
//   RLS-cohort tests): the REAL `buildEagerBaseNodeUpsert` UPSERT on the ENFORCED
//   `tanren_app` role — the eager_base node lands org-scoped, an off-scope org sees ZERO
//   rows, and a re-bootstrap of the SAME base + ordered ancestors is IDEMPOTENT (an UPSERT,
//   not a duplicate row).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getSystemPool, migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import {
  buildEagerBaseNodeUpsert,
  type EagerBaseNodeUpsert,
  type EagerBaseNodeUpsertFacts,
} from "../src/engine/workflow/plannerRunJjLocalBootstrap.js";
import { bootstrapLocalIntegrationRef } from "../src/engine/dag/jjLocalBootstrap.js";
import { memberKey } from "../src/engine/contracts/integrationNodes.js";
import { PgIntegrationNodeModel } from "../src/engine/dag/integrationNodesPg.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

function out(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

const ASSEMBLED_HEAD = "a".repeat(40);
const MEMBER_SHA = "b".repeat(40);
const TREE_HASH = "d".repeat(40);
const CLONE_HEAD = "c".repeat(40);
const WORKSPACE_PATH = "/workspace/runs/run_dep/repo";
const RUN_BRANCH = "tanren/run_dep";

function unusedHttp(): GitHubHttpClient {
  return {
    request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
      throw new Error(`no GitHub HTTP expected in this unit path: ${req.method} ${req.path}`);
    },
  };
}

// A command-dispatching substrate identical in spirit to plannerRunWorkspaceJjLocalBase's:
// the jj `commit_id` reads → the assembled head, the conflict probe → CLEAN, the tree read →
// a tree hash, the legacy clone → the clone HEAD. The REAL JjWorkspaceVcsCore drives the
// assembly with no real jj/runner.
class DispatchingSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const cmd = command.command;
    if (cmd.includes("conflicted") && cmd.includes("clean")) return out("change0\tclean");
    // The per-member PRISTINE head read (`jj log -r '<branch>@origin' -T 'commit_id'`) ⇒ a
    // member sha — checked BEFORE the bare `commit_id` branch (both use the commit_id
    // template; the `@origin` revset disambiguates the member read from the head read).
    if (cmd.includes("@origin")) return out(MEMBER_SHA);
    if (cmd.includes("commit_id")) return out(ASSEMBLED_HEAD);
    if (cmd.includes("rev-parse") && cmd.includes("^{tree}")) return out(TREE_HASH);
    if (cmd.includes("git clone") || cmd.includes("rev-parse HEAD")) return out(CLONE_HEAD);
    return out("");
  }
}

function makeContext(overrides: Partial<PlannerRunContext> = {}): PlannerRunContext {
  return {
    runId: "run_dep",
    specId: "spec_dep",
    projectId: "project_dep",
    orgId: "org_dep",
    repoUrl: "https://github.com/cat-cave/dep-fixture",
    targetBranch: "main",
    runBranch: RUN_BRANCH,
    specTitle: "t",
    specDescription: "d",
    acceptanceCriteria: [],
    runnerImage: "image",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "",
    ...overrides,
  };
}

function makeInput(
  ssh: CommandSubstrate,
  context: PlannerRunContext,
  eagerBaseNodeUpsert?: EagerBaseNodeUpsert,
): RunPlannerLoopInput {
  return {
    ssh,
    secrets: new FakeSecretStore(),
    vcsProvider: vcsProviderOver(unusedHttp()),
    context,
    timeoutMs: 500,
    bootstrapCommand: "true",
    runBootstrap: async () => {},
    commitBootstrap: async () => "",
    ...(eagerBaseNodeUpsert !== undefined && { eagerBaseNodeUpsert }),
  } as unknown as RunPlannerLoopInput;
}

const STACK: AncestorStack = [
  { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "" },
  { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "" },
];

// ===========================================================================
// PURE / WIRING layer — always-on, no DB.
// ===========================================================================

describe("eager_base node bootstrap UPSERT (wiring)", () => {
  const KEY = "WALKER_JJ_LOCAL_BASE";
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env[KEY];
    process.env[KEY] = "1";
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[KEY];
    else process.env[KEY] = prior;
  });

  it("FLAG ON + non-empty stack ⇒ UPSERTs an eager_base node with the ORDERED members + the local ref", async () => {
    const captured: EagerBaseNodeUpsertFacts[] = [];
    const ssh = new DispatchingSsh();
    const prepared = await prepareRunWorkspace(
      makeInput(ssh, makeContext({ ancestorStack: STACK }), async (facts) => {
        captured.push(facts);
      }),
      target,
      WORKSPACE_PATH,
    );

    // The run is UNAFFECTED by the observe-only write — it still assembled cleanly.
    expect(prepared.cloneHeadSha).toBe(ASSEMBLED_HEAD);
    expect(prepared.bootstrappedBaseRevision).toBe(bootstrapLocalIntegrationRef(RUN_BRANCH));

    // Exactly ONE eager_base node was recorded for the assembled base.
    expect(captured).toHaveLength(1);
    const facts = captured[0]!;
    expect(facts.orgId).toBe("org_dep");
    expect(facts.projectId).toBe("project_dep");
    expect(facts.baseBranch).toBe("main");
    // `ref` = the LOCAL assembly bookmark (matching how the batch path uses `.ref`).
    expect(facts.ref).toBe(bootstrapLocalIntegrationRef(RUN_BRANCH));
    // The assembled head/tree the node materializes as.
    expect(facts.headSha).toBe(ASSEMBLED_HEAD);
    expect(facts.treeHash).toBe(TREE_HASH);
    // The members are the ORDERED ancestor stack (DAG order is load-bearing for the
    // memberKey), each `{specId, runId, branch, headSha}` with the assembly-captured sha.
    expect(facts.members).toEqual([
      { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: MEMBER_SHA },
      { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: MEMBER_SHA },
    ]);
  });

  it("a node-write FAILURE is observe-only: it NEVER breaks the run", async () => {
    const ssh = new DispatchingSsh();
    const prepared = await prepareRunWorkspace(
      makeInput(ssh, makeContext({ ancestorStack: STACK }), async () => {
        throw new Error("simulated integration_nodes write failure");
      }),
      target,
      WORKSPACE_PATH,
    );
    // The run assembled cleanly DESPITE the node-write throw (loud-logged + swallowed).
    expect(prepared.cloneHeadSha).toBe(ASSEMBLED_HEAD);
    expect(prepared.bootstrappedBaseRevision).toBe(bootstrapLocalIntegrationRef(RUN_BRANCH));
  });

  it("a null-org run SKIPS the node write (no tenant key to scope to)", async () => {
    let called = false;
    const ssh = new DispatchingSsh();
    await prepareRunWorkspace(
      makeInput(ssh, makeContext({ ancestorStack: STACK, orgId: null }), async () => {
        called = true;
      }),
      target,
      WORKSPACE_PATH,
    );
    expect(called).toBe(false);
  });

  it("the legacy clone path (empty stack) writes NO eager_base node", async () => {
    let called = false;
    const ssh = new DispatchingSsh();
    // No ancestorStack ⇒ empty stack ⇒ the legacy single-ref clone (no bootstrap, no node).
    await prepareRunWorkspace(
      makeInput(ssh, makeContext(), async () => {
        called = true;
      }),
      target,
      WORKSPACE_PATH,
    );
    expect(called).toBe(false);
  });
});

// ===========================================================================
// DB layer — the REAL buildEagerBaseNodeUpsert UPSERT + fail-closed RLS.
// ===========================================================================

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_eager_base";
const PROJECT = `proj_${ORG}`;

function dbName(): string {
  return `tanren_eager_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("eager_base node bootstrap UPSERT (real DB + fail-closed RLS)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let upsert: EagerBaseNodeUpsert;
  let model: PgIntegrationNodeModel;

  const BASE_BRANCH = "main";
  const LOCAL_REF = bootstrapLocalIntegrationRef(RUN_BRANCH);
  const MEMBERS = [
    { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "1".repeat(40) },
    { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "2".repeat(40) },
  ];
  // The memberKey keys on the base identity (the base branch name — the assembly carries
  // the head, not the pristine `main` sha) + the ORDERED member shas.
  const EXPECTED_KEY = memberKey(BASE_BRANCH, [MEMBERS[0]!.headSha, MEMBERS[1]!.headSha]);

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });
    setSystemPool(new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) }));
    upsert = buildEagerBaseNodeUpsert(appPool);
    model = new PgIntegrationNodeModel(appPool);

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'p', 'https://example.test/r', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
      [PROJECT, ORG],
    );
  }, 60_000);

  afterAll(async () => {
    await getSystemPool()?.end();
    setSystemPool(undefined);
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("UPSERTs an eager_base node org-scoped; off-scope org sees ZERO rows; re-bootstrap is idempotent", async () => {
    await upsert({
      orgId: ORG,
      projectId: PROJECT,
      baseBranch: BASE_BRANCH,
      ref: LOCAL_REF,
      members: MEMBERS,
      headSha: ASSEMBLED_HEAD,
      treeHash: TREE_HASH,
    });

    const found = await model.findByMemberKey(ORG, EXPECTED_KEY);
    expect(found?.purpose).toBe("eager_base");
    expect(found?.ref).toBe(LOCAL_REF);
    expect(found?.headSha).toBe(ASSEMBLED_HEAD);
    expect(found?.treeHash).toBe(TREE_HASH);
    expect(found?.members.map((m) => m.specId)).toEqual(["spec-a", "spec-b"]);
    expect(found?.members.map((m) => m.headSha)).toEqual([MEMBERS[0]!.headSha, MEMBERS[1]!.headSha]);

    // RLS fail-closed: a DIFFERENT org sees ZERO rows for the same key.
    const offScope = await runWithOrgScope(appPool, "org_other_eager", async (client) => {
      const r = await client.query("SELECT node_id FROM integration_nodes WHERE member_key = $1", [EXPECTED_KEY]);
      return r.rowCount ?? 0;
    });
    expect(offScope).toBe(0);

    // Re-bootstrap the SAME base + ordered ancestors ⇒ an UPSERT, not a duplicate.
    await upsert({
      orgId: ORG,
      projectId: PROJECT,
      baseBranch: BASE_BRANCH,
      ref: LOCAL_REF,
      members: MEMBERS,
      headSha: ASSEMBLED_HEAD,
      treeHash: TREE_HASH,
    });
    const count = await runWithOrgScope(appPool, ORG, async (client) => {
      const r = await client.query("SELECT count(*)::int AS c FROM integration_nodes WHERE member_key = $1", [
        EXPECTED_KEY,
      ]);
      return r.rows[0]?.c as number;
    });
    expect(count).toBe(1);
  });
});
