import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createDbPool, migrate } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import { LocalDockerAllocator, PgRunnerStore } from "./engine/allocators/index.js";
import { InMemorySecretStore } from "./engine/contracts/index.js";
import { Ssh2Substrate } from "./engine/ssh/index.js";
import { runHelloWorkflow } from "./engine/workflow/helloRun.js";
import {
  createProject,
  createQueuedRunFromSpec,
  createSpec,
  ProjectNotFoundError,
  SpecDependenciesBlockedError,
  SpecNotRunnableError,
  SpecNotFoundError
} from "./engine/workflow/projectSpec.js";

const port = Number(process.env.ORCHESTRATOR_PORT ?? 3100);
const vaultAddr = process.env.VAULT_ADDR ?? "http://localhost:8200";
const vaultToken = process.env.VAULT_TOKEN ?? "dev-root-token";
const runnerIdentitySecretRef = process.env.TANREN_RUNNER_IDENTITY_SECRET_REF ?? "runner/local-docker/identity";
let productionPool: pg.Pool | undefined;

const projectInputSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  runnerImage: z.string().min(1).optional(),
  allocator: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional()
});

const specInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string().min(1)).optional()
});

const runInputSchema = z.object({
  trigger: z.enum(["cli", "dashboard", "api", "webhook"]).optional(),
  branch: z.string().min(1).optional()
});

async function vaultHealth() {
  const response = await fetch(`${vaultAddr}/v1/sys/health`, {
    headers: { "X-Vault-Token": vaultToken }
  });
  return { ok: response.ok || response.status === 429 || response.status === 472, status: response.status };
}

export async function createApp() {
  const pool = getProductionPool();
  await migrate(pool);
  const runnerSecrets = new InMemorySecretStore();
  await seedRunnerIdentitySecret(runnerSecrets);
  return buildApp({
    pool,
    helloDependencies: {
      allocator: new LocalDockerAllocator({ runners: new PgRunnerStore(pool) }),
      ssh: new Ssh2Substrate(runnerSecrets),
      identitySecretRef: runnerIdentitySecretRef
    }
  });
}

export function buildApp(input: {
  pool: pg.Pool;
  helloDependencies: Parameters<typeof runHelloWorkflow>[1];
  vaultHealthCheck?: () => Promise<{ ok: boolean; status: number }>;
}) {
  const app = new Hono();
  const vaultHealthCheck = input.vaultHealthCheck ?? vaultHealth;

  app.get("/healthz", async (c) => {
    const dbResult = await input.pool.query("SELECT 1 AS ok");
    const vault = await vaultHealthCheck();
    return c.json({
      service: "orchestrator",
      ok: dbResult.rows[0]?.ok === 1 && vault.ok,
      database: "ok",
      vault
    });
  });

  app.get("/version", (c) => c.json({ service: "orchestrator", version: process.env.npm_package_version ?? "0.0.0" }));

  app.post("/projects", async (c) => {
    const parsed = projectInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_project", issues: parsed.error.issues }, 400);
    }
    return c.json(await createProject(input.pool, parsed.data), 201);
  });

  app.post("/specs", async (c) => {
    const parsed = specInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_spec", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(await createSpec(input.pool, parsed.data), 201);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_dependency_not_found", message: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/specs/:specId/runs", async (c) => {
    const parsed = runInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_run", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(await createQueuedRunFromSpec(input.pool, { specId: c.req.param("specId"), ...parsed.data }), 201);
    } catch (error) {
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_not_found", message: error.message }, 404);
      }
      if (error instanceof SpecDependenciesBlockedError) {
        return c.json({ error: "spec_dependencies_blocked", message: error.message }, 409);
      }
      if (error instanceof SpecNotRunnableError) {
        return c.json({ error: "spec_not_runnable", message: error.message }, 409);
      }
      throw error;
    }
  });

  app.post("/hello/run", async (c) => {
    const summary = await runHelloWorkflow(input.pool, input.helloDependencies);
    return c.json(summary, 201);
  });

  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const run = await input.pool.query("SELECT * FROM runs WHERE run_id = $1", [runId]);
    if (run.rowCount === 0) {
      return c.json({ error: "run_not_found" }, 404);
    }

    const tasks = await input.pool.query(
      `SELECT * FROM tasks
       WHERE run_id = $1
       ORDER BY CASE kind WHEN 'plan' THEN 1 WHEN 'write' THEN 2 WHEN 'check' THEN 3 WHEN 'audit' THEN 4 ELSE 99 END,
                started_at ASC NULLS FIRST,
                task_id ASC`,
      [runId]
    );
    const events = await input.pool.query("SELECT * FROM events WHERE run_id = $1 ORDER BY ts ASC, id ASC", [runId]);
    const costs = await input.pool.query("SELECT * FROM cost_records WHERE run_id = $1 ORDER BY recorded_at ASC, id ASC", [runId]);
    return c.json({ run: run.rows[0], tasks: tasks.rows, events: events.rows, costs: costs.rows });
  });

  return app;
}

function getProductionPool(): pg.Pool {
  productionPool ??= createDbPool();
  return productionPool;
}

async function seedRunnerIdentitySecret(secrets: InMemorySecretStore): Promise<void> {
  const inlinePrivateKey = process.env.TANREN_RUNNER_IDENTITY_PRIVATE_KEY;
  if (inlinePrivateKey !== undefined && inlinePrivateKey !== "") {
    await secrets.put({ ref: runnerIdentitySecretRef, value: inlinePrivateKey });
    return;
  }

  const keyPath = process.env.TANREN_RUNNER_IDENTITY_KEY_PATH;
  if (keyPath !== undefined && keyPath !== "") {
    await secrets.put({ ref: runnerIdentitySecretRef, value: await readFile(keyPath, "utf8") });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  serve({ fetch: app.fetch, port });
  console.log(`orchestrator listening on :${port}`);
}
