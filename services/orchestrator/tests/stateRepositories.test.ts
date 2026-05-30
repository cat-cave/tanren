import { describe, expect, it } from "vitest";
import { IllegalRunTransitionError } from "../src/engine/state/index.js";
import { systemActor } from "../src/engine/state/actor.js";
import { ActorStore, JobStore, RunStore, SpecStore, TaskStore } from "../src/engine/repositories/index.js";

interface StubResult {
  rowCount: number;
  rows: ReadonlyArray<Record<string, unknown>>;
}

class StubClient {
  readonly queries: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  private readonly responses: StubResult[];

  constructor(responses: StubResult[]) {
    this.responses = [...responses];
  }

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<StubResult> {
    this.queries.push({ sql, params });
    const next = this.responses.shift();
    if (next === undefined) {
      return { rowCount: 0, rows: [] };
    }
    return next;
  }
}

describe("RunStore", () => {
  it("decodes a run row with a Phase 2 status and outcome", async () => {
    const client = new StubClient([
      {
        rowCount: 1,
        rows: [
          {
            run_id: "run_1",
            spec_id: "spec_1",
            project_id: "project_1",
            trigger: "cli",
            branch: "main",
            status: "completed",
            outcome: "phase1_fixture_complete",
            pr_url: null,
            started_at: new Date("2026-01-01T00:00:00Z"),
            ended_at: new Date("2026-01-01T00:01:00Z"),
            org_id: "org_acme",
            user_id: null,
          },
        ],
      },
    ]);
    const run = await RunStore.get(client, "run_1", systemActor);
    expect(run?.status).toBe("completed");
    expect(run?.outcome).toBe("phase1_fixture_complete");
  });

  it("rejects an unknown status at decode time", async () => {
    const client = new StubClient([
      {
        rowCount: 1,
        rows: [
          {
            run_id: "run_1",
            spec_id: "spec_1",
            project_id: "project_1",
            trigger: "cli",
            branch: "main",
            status: "vibing",
            outcome: null,
            pr_url: null,
            started_at: new Date(),
            ended_at: null,
            org_id: "org_acme",
            user_id: null,
          },
        ],
      },
    ]);
    await expect(RunStore.get(client, "run_1", systemActor)).rejects.toThrow(/status/iu);
  });

  it("updates status through the typed transition helper", async () => {
    const client = new StubClient([
      {
        rowCount: 1,
        rows: [
          {
            run_id: "run_1",
            spec_id: "spec_1",
            project_id: "project_1",
            trigger: "cli",
            branch: "main",
            status: "running",
            outcome: null,
            pr_url: null,
            started_at: new Date(),
            ended_at: null,
            org_id: "org_acme",
            user_id: null,
          },
        ],
      },
    ]);
    const run = await RunStore.updateStatus(client, "run_1", { from: "queued", to: "running" }, systemActor);
    expect(run.status).toBe("running");
    expect(client.queries[0].sql).toContain("UPDATE runs");
    expect(client.queries[0].params[1]).toBe("running");
  });

  it("refuses illegal transitions before querying the database", async () => {
    const client = new StubClient([]);
    await expect(
      RunStore.updateStatus(client, "run_1", { from: "queued", to: "completed" }, systemActor),
    ).rejects.toThrowError(IllegalRunTransitionError);
    expect(client.queries).toHaveLength(0);
  });
});

describe("SpecStore", () => {
  it("decodes a spec row including Phase 2 statuses", async () => {
    const client = new StubClient([
      {
        rowCount: 1,
        rows: [
          {
            spec_id: "spec_1",
            project_id: "project_1",
            title: "title",
            description: "desc",
            acceptance_criteria: ["one"],
            depends_on: [],
            status: "in_flight",
            org_id: "org_acme",
          },
        ],
      },
    ]);
    const spec = await SpecStore.get(client, "spec_1", systemActor);
    expect(spec?.status).toBe("in_flight");
    expect(spec?.acceptanceCriteria).toEqual(["one"]);
  });
});

describe("TaskStore", () => {
  it("decodes a task row with new agent kinds", async () => {
    const client = new StubClient([
      {
        rowCount: 1,
        rows: [
          {
            task_id: "task_1",
            run_id: "run_1",
            kind: "forge",
            title: "narrate",
            parent_task_id: null,
            status: "running",
            started_at: new Date(),
            ended_at: null,
            outcome: null,
            failure_kind: null,
            agent_kind: "forge_template",
            cli: "fake",
            model: null,
            attempt: 1,
            org_id: "org_acme",
            user_id: null,
          },
        ],
      },
    ]);
    const task = await TaskStore.get(client, "task_1", systemActor);
    expect(task?.kind).toBe("forge");
    expect(task?.agentKind).toBe("forge_template");
  });

  it("rejects an unknown agent kind", async () => {
    const client = new StubClient([
      {
        rowCount: 1,
        rows: [
          {
            task_id: "task_1",
            run_id: "run_1",
            kind: "plan",
            title: "p",
            parent_task_id: null,
            status: "queued",
            started_at: null,
            ended_at: null,
            outcome: null,
            failure_kind: null,
            agent_kind: "saboteur",
            cli: "fake",
            model: null,
            attempt: 1,
            org_id: "org_acme",
            user_id: null,
          },
        ],
      },
    ]);
    await expect(TaskStore.get(client, "task_1", systemActor)).rejects.toThrow(/agentKind|agent_kind|invalid/iu);
  });
});

describe("JobStore", () => {
  it("decodes a job row with new Phase 2 task kinds", async () => {
    const client = new StubClient([
      {
        rowCount: 1,
        rows: [
          {
            id: "42",
            run_id: "run_1",
            task_id: null,
            task_kind: "ci_poll",
            status: "queued",
            attempts: 0,
            failure_kind: null,
            failure_message: null,
            tenant_id: null,
            user_id: null,
          },
        ],
      },
    ]);
    const job = await JobStore.get(client, "42", systemActor);
    expect(job?.taskKind).toBe("ci_poll");
  });
});

describe("ActorStore", () => {
  it("decodes the agent kind for a task", async () => {
    const client = new StubClient([
      {
        rowCount: 1,
        rows: [{ task_id: "task_1", agent_kind: "writer_codex", cli: "codex", model: "gpt-5" }],
      },
    ]);
    const actor = await ActorStore.getForTask(client, "task_1", systemActor);
    expect(actor?.agentKind).toBe("writer_codex");
  });
});
