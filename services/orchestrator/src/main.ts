import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createDbPool, migrate } from "@tanren/db";
import { Hono } from "hono";
import { LocalDockerAllocator, PgRunnerStore } from "./engine/allocators/index.js";
import { InMemorySecretStore } from "./engine/contracts/index.js";
import { Ssh2Substrate } from "./engine/ssh/index.js";
import { runHelloWorkflow } from "./engine/workflow/helloRun.js";

const port = Number(process.env.ORCHESTRATOR_PORT ?? 3100);
const vaultAddr = process.env.VAULT_ADDR ?? "http://localhost:8200";
const vaultToken = process.env.VAULT_TOKEN ?? "dev-root-token";
const runnerIdentitySecretRef = process.env.TANREN_RUNNER_IDENTITY_SECRET_REF ?? "runner/local-docker/identity";
const pool = createDbPool();

async function vaultHealth() {
  const response = await fetch(`${vaultAddr}/v1/sys/health`, {
    headers: { "X-Vault-Token": vaultToken }
  });
  return { ok: response.ok || response.status === 429 || response.status === 472, status: response.status };
}

export async function createApp() {
  await migrate(pool);
  const runnerSecrets = new InMemorySecretStore();
  await seedRunnerIdentitySecret(runnerSecrets);
  const helloDependencies = {
    allocator: new LocalDockerAllocator({ runners: new PgRunnerStore(pool) }),
    ssh: new Ssh2Substrate(runnerSecrets),
    identitySecretRef: runnerIdentitySecretRef
  };

  const app = new Hono();

  app.get("/healthz", async (c) => {
    const dbResult = await pool.query("SELECT 1 AS ok");
    const vault = await vaultHealth();
    return c.json({
      service: "orchestrator",
      ok: dbResult.rows[0]?.ok === 1 && vault.ok,
      database: "ok",
      vault
    });
  });

  app.get("/version", (c) => c.json({ service: "orchestrator", version: process.env.npm_package_version ?? "0.0.0" }));

  app.post("/hello/run", async (c) => {
    const summary = await runHelloWorkflow(pool, helloDependencies);
    return c.json(summary, 201);
  });

  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const run = await pool.query("SELECT * FROM runs WHERE run_id = $1", [runId]);
    if (run.rowCount === 0) {
      return c.json({ error: "run_not_found" }, 404);
    }

    const tasks = await pool.query(
      `SELECT * FROM tasks
       WHERE run_id = $1
       ORDER BY CASE kind WHEN 'plan' THEN 1 WHEN 'write' THEN 2 WHEN 'check' THEN 3 WHEN 'audit' THEN 4 ELSE 99 END,
                started_at ASC NULLS FIRST,
                task_id ASC`,
      [runId]
    );
    const events = await pool.query("SELECT * FROM events WHERE run_id = $1 ORDER BY ts ASC, id ASC", [runId]);
    const costs = await pool.query("SELECT * FROM cost_records WHERE run_id = $1 ORDER BY recorded_at ASC, id ASC", [runId]);
    return c.json({ run: run.rows[0], tasks: tasks.rows, events: events.rows, costs: costs.rows });
  });

  return app;
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
