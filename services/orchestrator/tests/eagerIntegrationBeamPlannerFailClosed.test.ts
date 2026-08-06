import { describe, expect, it } from "vitest";
import { defaultProjectConfigV1 } from "../src/engine/config/projectConfig.js";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  EagerIntegrationBeamPlanner,
  shouldHoldEagerFailure,
} from "../src/engine/merge/eagerIntegrationBeamPlanner.js";
import { EagerBeamReadyCasLostError } from "../src/engine/merge/eagerBeamStore.js";

const BASE_SHA = "a".repeat(40);
const ANCESTOR_SHA = "b".repeat(40);
const FRONTIER_SHA = "c".repeat(40);

class EmptyCommandSubstrate implements CommandSubstrate {
  public async run(_target: never, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class ScriptedCommandSubstrate implements CommandSubstrate {
  public async run(_target: never, command: RunnerCommand): Promise<CommandResult> {
    if (command.command.includes("jj log")) {
      if (command.command.includes("feature/ancestor@origin")) return { exitCode: 0, stdout: ANCESTOR_SHA, stderr: "" };
      if (command.command.includes("feature/frontier@origin")) return { exitCode: 0, stdout: FRONTIER_SHA, stderr: "" };
      if (command.command.includes("conflict")) return { exitCode: 0, stdout: "change_eager\tclean", stderr: "" };
      return { exitCode: 0, stdout: "d".repeat(40), stderr: "" };
    }
    if (command.command.includes("git rev-parse")) return { exitCode: 0, stdout: "e".repeat(40), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class RefHttp {
  public async request(input: { path: string }): Promise<{ status: number; body: unknown }> {
    if (input.path === "/user") return { status: 200, body: { login: "eager-bot", id: 7 } };
    const branch = decodeURIComponent(input.path.split("/heads/")[1] ?? "");
    const refs = new Map([
      ["main", BASE_SHA],
      ["feature/ancestor", ANCESTOR_SHA],
      ["feature/frontier", FRONTIER_SHA],
    ]);
    const sha = refs.get(branch);
    return sha === undefined
      ? { status: 404, body: {} }
      : { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha } } };
  }
}

class PlannerPool {
  public readonly heldReasons: string[] = [];
  public projectVisible = true;
  public projectReadFails = false;
  public ancestorStack: unknown = [
    { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: ANCESTOR_SHA },
  ];

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("SELECT org_id FROM projects")) {
      if (this.projectReadFails) throw new Error("project reader unavailable");
      return this.projectVisible ? { rows: [{ org_id: "org_eager" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT p.repo_url")) {
      return {
        rows: [
          {
            repo_url: "https://github.com/owner/planner-failclosed.git",
            default_branch: "main",
            runner_image: "runner@sha256:test",
            project_config: { ...defaultProjectConfigV1(), credentials: { githubCredentialRef: "token" } },
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
            ancestor_stack: this.ancestorStack,
            priority: "P0",
            created_at: "2026-07-20T00:00:00.000Z",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT 1 FROM merge_eager_beams")) return { rows: [], rowCount: 0 };
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

async function planner(
  pool: PlannerPool,
  ssh: CommandSubstrate = new EmptyCommandSubstrate(),
): Promise<EagerIntegrationBeamPlanner> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/github/org/org_eager/token", value: "eager-token" });
  return new EagerIntegrationBeamPlanner({
    pool: pool.asPgPool(),
    secrets,
    githubHttp: new RefHttp(),
    allocator: new FakeAllocator(),
    ssh,
    identitySecretRef: "identity/eager",
  });
}

describe("EAGER planner local assembly failures", () => {
  it("does not frontier-hold a ready-CAS loser that could invalidate the winner", () => {
    expect(shouldHoldEagerFailure(new EagerBeamReadyCasLostError())).toBe(false);
    expect(shouldHoldEagerFailure(new Error("real materialization failure"))).toBe(true);
  });

  it("does not admit a speculative result when the project is absent or unreadable", async () => {
    const absent = new PlannerPool();
    absent.projectVisible = false;

    await (await planner(absent)).planAndBuild("project_absent");
    expect(absent.heldReasons).toEqual([]);

    const unreadable = new PlannerPool();
    unreadable.projectReadFails = true;
    await expect((await planner(unreadable)).planAndBuild("project_unreadable")).resolves.toBeUndefined();
    expect(unreadable.heldReasons).toEqual([]);
  });

  it("holds a malformed durable ancestor stack instead of attempting jj assembly", async () => {
    const pool = new PlannerPool();
    pool.ancestorStack = [{ specId: "spec_missing_head" }];

    await (await planner(pool)).planAndBuild("project_eager");

    expect(pool.heldReasons).toEqual(["malformed_ancestor_stack"]);
  });

  it("holds a local base that moved after fact collection, without admitting a node", async () => {
    const pool = new PlannerPool();

    await (await planner(pool, new ScriptedCommandSubstrate())).planAndBuild("project_eager");

    expect(pool.heldReasons).toEqual(["base_sha_moved"]);
  });

  it("holds the original frontier when real jj assembly cannot resolve its live ref", async () => {
    const pool = new PlannerPool();

    await (await planner(pool)).planAndBuild("project_eager");
    expect(pool.heldReasons).toEqual(["jj_assembly_failed"]);
  });
});
