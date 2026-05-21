import { randomUUID } from "node:crypto";
import type pg from "pg";
import { PgEventStore } from "./eventStore.js";
import { fakeAuditor, fakeChecker, fakePlanner, fakeWriter } from "./providers/fake.js";

export interface HelloRunSummary {
  runId: string;
  specId: string;
  projectId: string;
  outcome: "hello_world_complete";
  events: number;
}

export async function runHelloWorkflow(pool: pg.Pool): Promise<HelloRunSummary> {
  const projectId = `project_${randomUUID()}`;
  const specId = `spec_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const eventStore = new PgEventStore(pool);

  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator)
       VALUES ($1, 'hello-world', 'https://github.com/cat-cave/tanren-fixture-easy', 'main',
               'ghcr.io/cat-cave/tanren-runner:v0', 'local-docker')`,
      [projectId]
    );
    await pool.query(
      `INSERT INTO specs (spec_id, project_id, title, description, acceptance_criteria, status)
       VALUES ($1, $2, 'Hello world', 'Prove Tanren service connectivity', $3::jsonb, 'active')`,
      [specId, projectId, JSON.stringify(["A synthetic run completes and is visible"])]
    );
    await pool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, trigger, branch)
       VALUES ($1, $2, $3, 'cli', 'tanren/hello-world')`,
      [runId, specId, projectId]
    );

    await eventStore.append({ runId, specId, projectId, eventType: "hello.started", payload: {} });

    const planTaskId = `task_${randomUUID()}`;
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, kind, title, status, outcome, agent_kind, cli, model)
       VALUES ($1, $2, 'plan', 'Fake planner', 'done', 'ok', 'answerer', 'fake', 'fake-planner')`,
      [planTaskId, runId]
    );
    const plan = await fakePlanner.runAnswerer({ prompt: "Plan hello world", timeoutMs: 1_000 });
    await eventStore.append({ runId, taskId: planTaskId, specId, projectId, eventType: "planner.completed", payload: plan });

    const writeTaskId = `task_${randomUUID()}`;
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, kind, title, status, outcome, agent_kind, cli, model)
       VALUES ($1, $2, 'write', $3, 'done', 'ok', 'writer', 'fake', 'fake-writer')`,
      [writeTaskId, runId, plan.subtasks[0]?.title ?? "Fake writer"]
    );
    const writer = await fakeWriter.runWriter({ prompt: "Write hello world", workspace: "/workspace", timeoutMs: 1_000 });
    await eventStore.append({ runId, taskId: writeTaskId, specId, projectId, eventType: "writer.completed", payload: writer });
    await pool.query(
      `INSERT INTO cost_records
       (task_id, run_id, project_id, cli, provider, model, input_tokens, output_tokens, cached_tokens,
        cost_usd, pricing_mode, cost_source, cost_source_raw)
       VALUES ($1, $2, $3, 'fake', 'fake', 'fake-writer', $4, $5, $6, 0,
               'opportunity_cost', 'opportunity_computed', $7::jsonb)`,
      [
        writeTaskId,
        runId,
        projectId,
        writer.tokenUsage.inputTokens,
        writer.tokenUsage.outputTokens,
        writer.tokenUsage.cachedTokens,
        JSON.stringify({ source: "hello-world fake adapter" })
      ]
    );

    const checkTaskId = `task_${randomUUID()}`;
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, kind, title, status, outcome, agent_kind, cli, model)
       VALUES ($1, $2, 'check', 'Fake checker', 'done', 'ok', 'answerer', 'fake', 'fake-checker')`,
      [checkTaskId, runId]
    );
    const check = await fakeChecker.runAnswerer({ prompt: writer.diff, timeoutMs: 1_000 });
    await eventStore.append({ runId, taskId: checkTaskId, specId, projectId, eventType: "checker.completed", payload: check });

    const auditTaskId = `task_${randomUUID()}`;
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, kind, title, status, outcome, agent_kind, cli, model)
       VALUES ($1, $2, 'audit', 'Fake auditor', 'done', 'ok', 'answerer', 'fake', 'fake-auditor')`,
      [auditTaskId, runId]
    );
    const audit = await fakeAuditor.runAnswerer({ prompt: "Audit hello world", timeoutMs: 1_000 });
    await eventStore.append({ runId, taskId: auditTaskId, specId, projectId, eventType: "auditor.completed", payload: audit });

    await pool.query("UPDATE specs SET status = 'done' WHERE spec_id = $1", [specId]);
    await pool.query("UPDATE runs SET outcome = 'hello_world_complete', ended_at = now() WHERE run_id = $1", [runId]);
    await eventStore.append({
      runId,
      specId,
      projectId,
      eventType: "hello.completed",
      payload: { outcome: "hello_world_complete" }
    });
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }

  const { rows } = await pool.query("SELECT count(*)::int AS count FROM events WHERE run_id = $1", [runId]);
  return { runId, specId, projectId, outcome: "hello_world_complete", events: rows[0]?.count ?? 0 };
}
