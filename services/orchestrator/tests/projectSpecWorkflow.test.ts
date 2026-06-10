import { describe, expect, it } from "vitest";
import { InMemorySecretStore, type CommandSubstrate } from "../src/engine/contracts/index.js";
import { buildApp } from "../src/main.js";

// buildApp's default sidecar allocator REQUIRES a bearer token (no `"dev"` fallback).
process.env.TANREN_ALLOCATOR_TOKEN ??= "test-token";
const ssh = {} as CommandSubstrate;
const doneOrMerged = (status: string): boolean => status === "merged";

describe("project/spec workflow contract", () => {
  it("creates a project, creates a spec, and queues a run from persisted rows", async () => {
    const pool = new ContractPool();
    const app = await buildApp({
      pool: pool.asPgPool(),
      ssh,
      secrets: new InMemorySecretStore(),
      vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    });

    const projectResponse = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Tanren",
        repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
        config: { version: 1 },
      }),
    });
    const project = await projectResponse.json();

    expect(projectResponse.status).toBe(201);
    expect(project).toMatchObject({
      projectId: expect.stringMatching(/^project_/u),
      defaultBranch: "main",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      allocator: "local-docker",
    });

    const foundationResponse = await app.request("/specs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.projectId,
        title: "Foundation",
        description: "Prepare the repo",
        acceptanceCriteria: ["Foundation exists"],
      }),
    });
    const foundation = await foundationResponse.json();
    pool.markSpecDone(foundation.specId);

    const specResponse = await app.request("/specs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.projectId,
        title: "Add health check",
        description: "Add a health endpoint",
        acceptanceCriteria: ["GET /healthz returns ok"],
        dependsOn: [foundation.specId],
      }),
    });
    const spec = await specResponse.json();

    expect(specResponse.status).toBe(201);
    expect(spec).toMatchObject({
      specId: expect.stringMatching(/^spec_/u),
      projectId: project.projectId,
      status: "open",
      dependsOn: [foundation.specId],
      priority: "tbd",
    });

    const runResponse = await app.request(`/specs/${spec.specId}/runs`, { method: "POST" });
    const run = await runResponse.json();

    expect(runResponse.status).toBe(201);
    expect(run).toMatchObject({
      runId: expect.stringMatching(/^run_/u),
      specId: spec.specId,
      projectId: project.projectId,
      trigger: "cli",
      branch: expect.stringMatching(/^tanren\/add-health-check-/u),
      status: "queued",
      project: {
        repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
        defaultBranch: "main",
      },
      spec: { acceptanceCriteria: ["GET /healthz returns ok"], status: "in_flight" },
      plannerTaskId: expect.stringMatching(/^task_/u),
      plannerJobId: expect.stringMatching(/^\d+$/u),
    });
    expect(pool.runs[0]).toMatchObject({
      specId: spec.specId,
      projectId: project.projectId,
      status: "queued",
    });
    expect(pool.tasks[0]).toMatchObject({
      runId: run.runId,
      kind: "plan",
      status: "queued",
      agentKind: "answerer",
    });
    expect(pool.jobs[0]).toMatchObject({
      runId: run.runId,
      taskId: run.plannerTaskId,
      taskKind: "plan",
      status: "queued",
    });
    const duplicateRun = await app.request(`/specs/${spec.specId}/runs`, { method: "POST" });

    expect(duplicateRun.status).toBe(409);
    await expect(duplicateRun.json()).resolves.toMatchObject({ error: "spec_not_runnable" });
    expect(pool.events).toEqual([
      expect.objectContaining({
        runId: run.runId,
        specId: spec.specId,
        projectId: project.projectId,
        eventType: "run.queued",
        payload: expect.objectContaining({
          branch: run.branch,
          project: expect.objectContaining({
            repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
            defaultBranch: "main",
          }),
        }),
      }),
      expect.objectContaining({
        runId: run.runId,
        taskId: run.plannerTaskId,
        specId: spec.specId,
        projectId: project.projectId,
        eventType: "task.queued",
        payload: { taskKind: "plan", jobId: run.plannerJobId },
      }),
    ]);
  });

  it("returns not found when creating a spec for a missing project", async () => {
    const app = await buildApp({
      pool: new ContractPool().asPgPool(),
      ssh,
      secrets: new InMemorySecretStore(),
      vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    });

    const response = await app.request("/specs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project_missing",
        title: "Missing",
        description: "Missing project",
        acceptanceCriteria: ["A 404 is returned"],
      }),
    });

    await expect(response.json()).resolves.toMatchObject({ error: "project_not_found" });
    expect(response.status).toBe(404);
  });

  it("rejects empty acceptance criteria and invalid run triggers", async () => {
    const pool = new ContractPool();
    const app = await buildApp({
      pool: pool.asPgPool(),
      ssh,
      secrets: new InMemorySecretStore(),
      vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    });
    const projectResponse = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Tanren",
        repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      }),
    });
    const project = await projectResponse.json();
    const invalidSpec = await app.request("/specs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.projectId,
        title: "Bad",
        description: "Bad",
        acceptanceCriteria: [],
      }),
    });

    expect(invalidSpec.status).toBe(400);
  });

  it("blocks runs until same-project dependencies are done", async () => {
    const pool = new ContractPool();
    const app = await buildApp({
      pool: pool.asPgPool(),
      ssh,
      secrets: new InMemorySecretStore(),
      vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    });
    const project = await (
      await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Tanren",
          repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
        }),
      })
    ).json();
    const foundation = await (
      await app.request("/specs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.projectId,
          title: "Foundation",
          description: "Prepare the repo",
          acceptanceCriteria: ["Foundation exists"],
        }),
      })
    ).json();
    const dependent = await (
      await app.request("/specs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.projectId,
          title: "Dependent",
          description: "Needs foundation",
          acceptanceCriteria: ["Dependency is enforced"],
          dependsOn: [foundation.specId],
        }),
      })
    ).json();

    const blocked = await app.request(`/specs/${dependent.specId}/runs`, { method: "POST" });
    pool.markSpecDone(foundation.specId);
    const invalidTrigger = await app.request(`/specs/${dependent.specId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "cron" }),
    });

    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ error: "spec_dependencies_blocked" });
    expect(invalidTrigger.status).toBe(400);
  });
});

class ContractPool {
  readonly projects = new Map<string, ProjectRow>();
  readonly specs = new Map<string, SpecRow>();
  readonly runs: RunRow[] = [];
  readonly tasks: TaskRow[] = [];
  readonly jobs: JobRow[] = [];
  readonly events: EventRow[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO projects")) {
      const project = projectFromParams(params);
      this.projects.set(project.projectId, project);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT project_id FROM projects")) {
      const project = this.projects.get(String(params[0]));
      return {
        rows: project === undefined ? [] : [{ project_id: project.projectId }],
        rowCount: project === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY")) {
      return this.selectSpecsForProject(String(params[0]), params[1] as string[]);
    }
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id = $1 AND status = 'merged'")) {
      return this.selectDoneSpecsForProject(String(params[0]), params[1] as string[]);
    }
    if (sql.startsWith("INSERT INTO specs")) {
      const spec = specFromParams(params);
      this.specs.set(spec.specId, spec);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM specs s") && sql.includes("JOIN projects p")) {
      return this.selectSpecProject(String(params[0]));
    }
    if (sql.startsWith("INSERT INTO runs")) {
      this.runs.push(runFromParams(params));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE specs SET status = 'in_flight'")) {
      const spec = this.specs.get(String(params[0]));
      if (spec !== undefined && spec.status === "open") {
        spec.status = "in_flight";
        return { rows: [{ spec_id: spec.specId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO tasks")) {
      this.tasks.push(taskFromParams(params));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO job_queue")) {
      const job = jobFromParams(params, this.jobs.length + 1);
      this.jobs.push(job);
      return { rows: [{ id: String(job.id) }], rowCount: 1 };
    }
    if (sql.startsWith(`INSERT INTO ${"events"}`)) {
      this.events.push(eventFromParams(params));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // A client VIEW sharing `query` but with NO `connect` (like a real PoolClient),
  // so the RLS write-path `isPool` discriminator uses a handed-in client verbatim.
  async connect() {
    return { query: (s: string, p?: unknown[]) => this.query(s, p ?? []), release: () => {} } as never;
  }

  release(): void {}

  asPgPool() {
    return this as never;
  }

  markSpecDone(specId: string): void {
    const spec = this.specs.get(specId);
    if (spec !== undefined) spec.status = "merged";
  }

  private selectSpecsForProject(projectId: string, specIds: string[]): { rows: unknown[]; rowCount: number } {
    const rows = specIds
      .map((specId) => this.specs.get(specId))
      .filter((spec): spec is SpecRow => spec !== undefined && spec.projectId === projectId)
      .map((spec) => ({ spec_id: spec.specId }));
    return { rows, rowCount: rows.length };
  }

  private selectDoneSpecsForProject(projectId: string, specIds: string[]): { rows: unknown[]; rowCount: number } {
    const rows = specIds
      .map((specId) => this.specs.get(specId))
      .filter((spec): spec is SpecRow => spec?.projectId === projectId && doneOrMerged(spec.status))
      .map((spec) => ({ spec_id: spec.specId }));
    return { rows, rowCount: rows.length };
  }

  private selectSpecProject(specId: string): { rows: unknown[]; rowCount: number } {
    const spec = this.specs.get(specId);
    const project = spec === undefined ? undefined : this.projects.get(spec.projectId);
    if (spec === undefined || project === undefined) {
      return { rows: [], rowCount: 0 };
    }
    return {
      rows: [
        {
          project_id: project.projectId,
          name: project.name,
          repo_url: project.repoUrl,
          default_branch: project.defaultBranch,
          runner_image: project.runnerImage,
          allocator: project.allocator,
          config: project.config,
          spec_id: spec.specId,
          title: spec.title,
          description: spec.description,
          acceptance_criteria: spec.acceptanceCriteria,
          depends_on: spec.dependsOn,
          status: spec.status,
          priority: spec.priority,
        },
      ],
      rowCount: 1,
    };
  }
}

interface ProjectRow {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  runnerImage: string;
  allocator: string;
  config: Record<string, unknown>;
}

interface SpecRow {
  specId: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: string;
  priority: string;
}

interface RunRow {
  runId: string;
  specId: string;
  projectId: string;
  trigger: string;
  branch: string;
  status: string;
}

interface TaskRow {
  taskId: string;
  runId: string;
  kind: string;
  status: string;
  agentKind: string;
}

interface JobRow {
  id: number;
  runId: string;
  taskId: string;
  taskKind: string;
  status: string;
}

interface EventRow {
  runId: string;
  taskId?: string;
  specId: string;
  projectId: string;
  eventType: string;
  payload: unknown;
}

function projectFromParams(params: unknown[]): ProjectRow {
  return {
    projectId: String(params[0]),
    name: String(params[1]),
    repoUrl: String(params[2]),
    defaultBranch: String(params[3]),
    runnerImage: String(params[4]),
    allocator: String(params[5]),
    config: JSON.parse(String(params[6])) as Record<string, unknown>,
  };
}

function specFromParams(params: unknown[]): SpecRow {
  return {
    specId: String(params[0]),
    projectId: String(params[1]),
    title: String(params[2]),
    description: String(params[3]),
    acceptanceCriteria: JSON.parse(String(params[4])) as string[],
    dependsOn: params[5] as string[],
    status: String(params[6]),
    priority: String(params[7]),
  };
}

function runFromParams(params: unknown[]): RunRow {
  return {
    runId: String(params[0]),
    specId: String(params[1]),
    projectId: String(params[2]),
    trigger: String(params[3]),
    branch: String(params[4]),
    status: "queued",
  };
}

function taskFromParams(params: unknown[]): TaskRow {
  return {
    taskId: String(params[0]),
    runId: String(params[1]),
    kind: "plan",
    status: "queued",
    agentKind: "answerer",
  };
}

function jobFromParams(params: unknown[], id: number): JobRow {
  return {
    id,
    runId: String(params[0]),
    taskId: String(params[1]),
    taskKind: "plan",
    status: "queued",
  };
}

function eventFromParams(params: unknown[]): EventRow {
  return {
    runId: String(params[0]),
    taskId: params[1] === null ? undefined : String(params[1]),
    specId: String(params[2]),
    projectId: String(params[3]),
    eventType: String(params[4]),
    payload: JSON.parse(String(params[5])) as unknown,
  };
}
