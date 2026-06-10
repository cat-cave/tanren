import { describe, expect, it } from "vitest";
import { systemActor } from "../src/engine/state/actor.js";
import { ActorStore, JobStore, RunStore, SpecStore, TaskStore } from "../src/engine/repositories/index.js";

// ---------------------------------------------------------------------------
// Behavior-pinning suite (mutation ratchet) for the engine/repositories DAL
// stores. Each block below asserts a real observable behavior of a store: the
// exact column list its SELECT/UPDATE emits, the row->entity coercion
// (string<->number) the decoder performs, the array-field filtering in the
// spec decoder, the dynamic SET/WHERE/ORDER BY the SQL builders assemble, and
// not-found handling. Every test asserts an outcome (decoded entity and/or
// emitted SQL/params) driven through the store against a recording query
// client — never a mock-call expectation.
// ---------------------------------------------------------------------------

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

function jobRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "7",
    run_id: "run_1",
    task_id: "task_1",
    task_kind: "ci_poll",
    status: "queued",
    attempts: 0,
    failure_kind: null,
    failure_message: null,
    tenant_id: null,
    user_id: null,
    ...over,
  };
}

function taskRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: "task_1",
    run_id: "run_1",
    kind: "plan",
    title: "t",
    parent_task_id: null,
    status: "queued",
    started_at: null,
    ended_at: null,
    outcome: null,
    failure_kind: null,
    agent_kind: "forge_template",
    cli: "fake",
    model: null,
    attempt: 1,
    org_id: "org_acme",
    user_id: null,
    ...over,
  };
}

function runRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run_1",
    spec_id: "spec_1",
    project_id: "project_1",
    trigger: "cli",
    branch: "main",
    status: "running",
    outcome: null,
    pr_url: null,
    started_at: new Date("2026-01-01T00:00:00Z"),
    ended_at: null,
    org_id: "org_acme",
    user_id: null,
    ...over,
  };
}

function specRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec_id: "spec_1",
    project_id: "project_1",
    title: "title",
    description: "desc",
    acceptance_criteria: ["one"],
    depends_on: [],
    status: "open",
    priority: "tbd",
    org_id: "org_acme",
    ...over,
  };
}

describe("JobStore SQL + coercion", () => {
  it("selects the full job column projection by name and id (SELECT/get)", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [jobRow()] }]);
    await JobStore.get(client, "7", systemActor);
    const sql = client.queries[0].sql;
    expect(sql).toContain("FROM job_queue");
    expect(sql).toContain("id::text AS id");
    for (const col of [
      "run_id",
      "task_id",
      "task_kind",
      "status",
      "attempts",
      "failure_kind",
      "failure_message",
      "tenant_id",
      "user_id",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain("WHERE id = $1");
    expect(client.queries[0].params).toEqual(["7"]);
  });

  it("coerces a non-string id into a string id", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [jobRow({ id: 42 })] }]);
    const job = await JobStore.get(client, "42", systemActor);
    expect(job?.id).toBe("42");
    expect(typeof job?.id).toBe("string");
  });

  it("keeps an already-string id untouched", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [jobRow({ id: "abc" })] }]);
    const job = await JobStore.get(client, "abc", systemActor);
    expect(job?.id).toBe("abc");
  });

  it("coerces a numeric-string attempts into a number", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [jobRow({ attempts: "3" })] }]);
    const job = await JobStore.get(client, "7", systemActor);
    expect(job?.attempts).toBe(3);
    expect(typeof job?.attempts).toBe("number");
  });

  it("keeps an already-number attempts untouched", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [jobRow({ attempts: 5 })] }]);
    const job = await JobStore.get(client, "7", systemActor);
    expect(job?.attempts).toBe(5);
  });

  it("returns undefined for an unknown job id", async () => {
    const client = new StubClient([{ rowCount: 0, rows: [] }]);
    expect(await JobStore.get(client, "nope", systemActor)).toBeUndefined();
  });

  it("filters and orders the job list by enqueued_at", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [jobRow()] }]);
    const jobs = await JobStore.list(client, { runId: "run_1", taskKind: "ci_poll", status: "queued" }, systemActor);
    expect(jobs).toHaveLength(1);
    const sql = client.queries[0].sql;
    expect(sql).toContain("WHERE run_id = $1 AND task_kind = $2 AND status = $3");
    expect(sql).toContain("ORDER BY enqueued_at");
    expect(client.queries[0].params).toEqual(["run_1", "ci_poll", "queued"]);
  });

  it("omits the WHERE clause when listing jobs without a filter", async () => {
    const client = new StubClient([{ rowCount: 0, rows: [] }]);
    await JobStore.list(client, undefined, systemActor);
    const sql = client.queries[0].sql;
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("ORDER BY enqueued_at");
    expect(client.queries[0].params).toEqual([]);
  });

  it("builds the failure UPDATE with sequential params and RETURNING columns", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [jobRow({ status: "failed", attempts: 2 })] }]);
    const job = await JobStore.updateStatus(
      client,
      "7",
      { from: "running", to: "failed", failureKind: "timeout", failureMessage: "boom", setEndedAt: true },
      systemActor,
    );
    expect(job.status).toBe("failed");
    const sql = client.queries[0].sql;
    expect(sql).toContain("UPDATE job_queue SET status = $2");
    expect(sql).toContain("failure_kind = $3");
    expect(sql).toContain("failure_message = $4");
    expect(sql).toContain("ended_at = now()");
    expect(sql).toContain("WHERE id = $1 RETURNING");
    expect(sql).toContain("task_kind");
    expect(client.queries[0].params).toEqual(["7", "failed", "timeout", "boom"]);
  });

  it("omits optional SET fragments when not requested", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [jobRow({ status: "running" })] }]);
    await JobStore.updateStatus(client, "7", { from: "claimed", to: "running" }, systemActor);
    const sql = client.queries[0].sql;
    const setClause = sql.slice(0, sql.indexOf("WHERE id = $1"));
    expect(sql).toContain("SET status = $2 WHERE id = $1");
    expect(setClause).not.toContain("failure_kind = ");
    expect(setClause).not.toContain("ended_at = now()");
    expect(client.queries[0].params).toEqual(["7", "running"]);
  });

  it("throws when updating a job that no longer exists", async () => {
    const client = new StubClient([{ rowCount: 0, rows: [] }]);
    await expect(JobStore.updateStatus(client, "7", { from: "claimed", to: "running" }, systemActor)).rejects.toThrow(
      /job not found: 7/u,
    );
  });
});

describe("TaskStore SQL + coercion", () => {
  it("selects the full task column projection by name (SELECT/get)", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [taskRow()] }]);
    await TaskStore.get(client, "task_1", systemActor);
    const sql = client.queries[0].sql;
    expect(sql).toContain("FROM tasks");
    for (const col of [
      "task_id",
      "run_id",
      "kind",
      "title",
      "parent_task_id",
      "status",
      "started_at",
      "ended_at",
      "outcome",
      "failure_kind",
      "agent_kind",
      "cli",
      "model",
      "attempt",
      "org_id",
      "user_id",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain("WHERE task_id = $1");
  });

  it("coerces a numeric-string attempt into a number", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [taskRow({ attempt: "4" })] }]);
    const task = await TaskStore.get(client, "task_1", systemActor);
    expect(task?.attempt).toBe(4);
    expect(typeof task?.attempt).toBe("number");
  });

  it("keeps an already-number attempt untouched", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [taskRow({ attempt: 9 })] }]);
    const task = await TaskStore.get(client, "task_1", systemActor);
    expect(task?.attempt).toBe(9);
  });

  it("filters and orders the task list by task_id", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [taskRow()] }]);
    await TaskStore.list(client, { runId: "run_1", kind: "plan", status: "queued" }, systemActor);
    const sql = client.queries[0].sql;
    expect(sql).toContain("WHERE run_id = $1 AND kind = $2 AND status = $3");
    expect(sql).toContain("ORDER BY task_id");
    expect(client.queries[0].params).toEqual(["run_1", "plan", "queued"]);
  });

  it("builds the task UPDATE with outcome, started_at and ended_at fragments", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [taskRow({ status: "done", outcome: "passed" })] }]);
    const task = await TaskStore.updateStatus(
      client,
      "task_1",
      { from: "running", to: "done", outcome: "passed", setStartedAt: true, setEndedAt: true },
      systemActor,
    );
    expect(task.status).toBe("done");
    expect(task.outcome).toBe("passed");
    const sql = client.queries[0].sql;
    expect(sql).toContain("UPDATE tasks SET status = $2");
    expect(sql).toContain("outcome = $3");
    expect(sql).toContain("started_at = COALESCE(started_at, now())");
    expect(sql).toContain("ended_at = now()");
    expect(sql).toContain("WHERE task_id = $1 RETURNING");
    expect(client.queries[0].params).toEqual(["task_1", "done", "passed"]);
  });

  it("throws when updating a task that no longer exists", async () => {
    const client = new StubClient([{ rowCount: 0, rows: [] }]);
    await expect(
      TaskStore.updateStatus(client, "task_1", { from: "queued", to: "running" }, systemActor),
    ).rejects.toThrow(/task not found: task_1/u);
  });
});

describe("RunStore SQL", () => {
  it("selects the full run column projection by name (SELECT/get)", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [runRow()] }]);
    await RunStore.get(client, "run_1", systemActor);
    const sql = client.queries[0].sql;
    expect(sql).toContain("FROM runs");
    for (const col of [
      "run_id",
      "spec_id",
      "project_id",
      "trigger",
      "branch",
      "status",
      "outcome",
      "pr_url",
      "started_at",
      "ended_at",
      "org_id",
      "user_id",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain("WHERE run_id = $1");
  });

  it("lists runs newest-first, unfiltered when no project is given", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [runRow()] }]);
    await RunStore.list(client, undefined, systemActor);
    const sql = client.queries[0].sql;
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("ORDER BY started_at DESC");
  });

  it("filters runs by project and orders newest-first", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [runRow()] }]);
    await RunStore.list(client, { projectId: "project_1" }, systemActor);
    const sql = client.queries[0].sql;
    expect(sql).toContain("WHERE project_id = $1");
    expect(sql).toContain("ORDER BY started_at DESC");
    expect(client.queries[0].params).toEqual(["project_1"]);
  });

  it("includes outcome and ended_at fragments in the run UPDATE when requested", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [runRow({ status: "completed", outcome: "ok" })] }]);
    const run = await RunStore.updateStatus(
      client,
      "run_1",
      { from: "running", to: "completed", outcome: "ok", setEndedAt: true },
      systemActor,
    );
    expect(run.outcome).toBe("ok");
    const sql = client.queries[0].sql;
    expect(sql).toContain("UPDATE runs SET status = $2");
    expect(sql).toContain("outcome = $3");
    expect(sql).toContain("ended_at = now()");
    expect(sql).toContain("WHERE run_id = $1 RETURNING");
    expect(client.queries[0].params).toEqual(["run_1", "completed", "ok"]);
  });

  it("throws when updating a run that no longer exists", async () => {
    const client = new StubClient([{ rowCount: 0, rows: [] }]);
    await expect(
      RunStore.updateStatus(client, "run_1", { from: "queued", to: "running" }, systemActor),
    ).rejects.toThrow(/run not found: run_1/u);
  });
});

describe("SpecStore SQL + array decoding", () => {
  it("selects the full spec column projection by name (SELECT/get)", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [specRow()] }]);
    await SpecStore.get(client, "spec_1", systemActor);
    const sql = client.queries[0].sql;
    expect(sql).toContain("FROM specs");
    for (const col of [
      "spec_id",
      "project_id",
      "title",
      "description",
      "acceptance_criteria",
      "depends_on",
      "status",
      "priority",
      "org_id",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain("WHERE spec_id = $1");
  });

  it("keeps only string members of an array field and drops non-strings", async () => {
    const client = new StubClient([
      { rowCount: 1, rows: [specRow({ acceptance_criteria: ["keep", 7, null, "also", { x: 1 }] })] },
    ]);
    const spec = await SpecStore.get(client, "spec_1", systemActor);
    expect(spec?.acceptanceCriteria).toEqual(["keep", "also"]);
  });

  it("falls back to an empty array when an array field is not an array", async () => {
    const client = new StubClient([
      { rowCount: 1, rows: [specRow({ acceptance_criteria: "not-an-array", depends_on: null })] },
    ]);
    const spec = await SpecStore.get(client, "spec_1", systemActor);
    expect(spec?.acceptanceCriteria).toEqual([]);
    expect(spec?.dependsOn).toEqual([]);
  });

  it("lists specs by project ordered by spec_id", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [specRow()] }]);
    await SpecStore.list(client, { projectId: "project_1" }, systemActor);
    const sql = client.queries[0].sql;
    expect(sql).toContain("WHERE project_id = $1");
    expect(sql).toContain("ORDER BY spec_id");
    expect(client.queries[0].params).toEqual(["project_1"]);
  });

  it("lists all specs ordered by spec_id when unfiltered", async () => {
    const client = new StubClient([{ rowCount: 0, rows: [] }]);
    await SpecStore.list(client, undefined, systemActor);
    const sql = client.queries[0].sql;
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("ORDER BY spec_id");
  });

  it("updates a spec status and returns the decoded spec columns", async () => {
    const client = new StubClient([{ rowCount: 1, rows: [specRow({ status: "in_flight" })] }]);
    const spec = await SpecStore.updateStatus(client, "spec_1", { from: "open", to: "in_flight" }, systemActor);
    expect(spec.status).toBe("in_flight");
    const sql = client.queries[0].sql;
    expect(sql).toContain("UPDATE specs SET status = $2 WHERE spec_id = $1 RETURNING");
    expect(sql).toContain("acceptance_criteria");
    expect(client.queries[0].params).toEqual(["spec_1", "in_flight"]);
  });

  it("throws when updating a spec that no longer exists", async () => {
    const client = new StubClient([{ rowCount: 0, rows: [] }]);
    await expect(
      SpecStore.updateStatus(client, "spec_1", { from: "open", to: "in_flight" }, systemActor),
    ).rejects.toThrow(/spec not found: spec_1/u);
  });
});

describe("ActorStore SQL", () => {
  it("selects the actor projection for a single task", async () => {
    const client = new StubClient([
      { rowCount: 1, rows: [{ task_id: "task_1", agent_kind: "writer", cli: "codex", model: "gpt-5" }] },
    ]);
    await ActorStore.getForTask(client, "task_1", systemActor);
    const sql = client.queries[0].sql;
    expect(sql).toContain("SELECT task_id, agent_kind, cli, model FROM tasks");
    expect(sql).toContain("WHERE task_id = $1");
    expect(client.queries[0].params).toEqual(["task_1"]);
  });

  it("returns undefined when no actor row exists for the task", async () => {
    const client = new StubClient([{ rowCount: 0, rows: [] }]);
    expect(await ActorStore.getForTask(client, "task_x", systemActor)).toBeUndefined();
  });

  it("lists actors for a run ordered by task_id", async () => {
    const client = new StubClient([
      { rowCount: 1, rows: [{ task_id: "task_1", agent_kind: "forge_template", cli: "fake", model: null }] },
    ]);
    const actors = await ActorStore.listForRun(client, "run_1", systemActor);
    expect(actors).toHaveLength(1);
    const sql = client.queries[0].sql;
    expect(sql).toContain("SELECT task_id, agent_kind, cli, model FROM tasks");
    expect(sql).toContain("WHERE run_id = $1");
    expect(sql).toContain("ORDER BY task_id");
    expect(client.queries[0].params).toEqual(["run_1"]);
  });
});
