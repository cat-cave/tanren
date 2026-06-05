// Shared harness for the plane-split P3 control-plane write-endpoint integration
// tests (REAL Postgres under the enforced `tanren_app` RLS role). The cohort is
// split across sibling files to stay under the repo's per-file `max-lines` cap,
// each `describeDb`-gated on the same env and standing up its own throwaway DB:
//
//   - planeSplitP3RemoteWrites.integration.test.ts        — the run-state writes
//     (append-event / record-cost / reconcile / finalize) + the DirectRunStateWriter.
//   - planeSplitP3CreateWrites.integration.test.ts        — the AUTONOMY-LOOP
//     create/intake/percolation writes (create-queued-run · set-spec-metadata ·
//     the change-percolation run-column ops).
//
// Both share this module's DB lifecycle (per-file throwaway database + migrate +
// the `tanren_app` runtime pool), the tenant constants, the in-process
// `fetchInto` mTLS shim, and the `seedRun` owner-seed helper — so the split keeps
// ONE source of truth for the harness with no behavioral drift.

import { Pool } from "pg";
import { migrate } from "@tanren/db";
import type { MtlsFetch } from "../src/engine/contracts/index.js";
import type { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";

export const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

export const ORG = "org_p3_rw";
export const PROJECT = `proj_${ORG}`;
export const SPEC = `spec_${ORG}`;
export const PLAN_TASK = `task_plan_${ORG}`;

function dbName(): string {
  return `tanren_p3_rw_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

// Route a fake MtlsFetch straight into the real endpoint app — the
// worker→control-plane round trip with the network swapped for an in-process
// call, so the write logic + wire shape are proven without standing up TLS.
export function fetchInto(app: ReturnType<typeof createInternalRunStateWriteRoutes>): MtlsFetch {
  return (url, init) => app.request(new URL(url).pathname, init as RequestInit, { incoming: { socket: {} } });
}

/**
 * The per-file DB lifecycle: a throwaway database the table OWNER migrates, plus
 * the `tanren_app` RUNTIME pool the endpoints run under (enforced RLS). Returns
 * lazily-populated pool getters (valid after `setUp`) + the `beforeAll`/`afterAll`
 * bodies a test file wires into vitest. Each file gets its OWN database (distinct
 * `dbName`), so the split files never collide.
 */
export function createWriteEndpointHarness(): {
  ownerPool: () => Pool;
  runtimePool: () => Pool;
  setUp: () => Promise<void>;
  tearDown: () => Promise<void>;
} {
  const database = dbName();
  let owner: Pool | undefined;
  let runtime: Pool | undefined;

  return {
    ownerPool: () => {
      if (owner === undefined) throw new Error("harness not set up: call setUp in beforeAll");
      return owner;
    },
    runtimePool: () => {
      if (runtime === undefined) throw new Error("harness not set up: call setUp in beforeAll");
      return runtime;
    },
    setUp: async () => {
      const adminPool = new Pool({ connectionString: ADMIN_URL });
      await adminPool.query(`CREATE DATABASE ${database}`);
      await adminPool.end();
      owner = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
      await migrate(owner);
      runtime = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });
    },
    tearDown: async () => {
      await runtime?.end();
      await owner?.end();
      const adminPool = new Pool({ connectionString: ADMIN_URL });
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [database],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
      await adminPool.end();
    },
  };
}

// Seed a run (distinct run_id per test so finalize transitions do not collide),
// as the OWNER (RLS does not apply to the table owner). Establishes the org +
// project + spec the run hangs off, plus a `plan` task.
export async function seedRun(ownerPool: Pool, runId: string, status = "running"): Promise<void> {
  await ownerPool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    [ORG],
  );
  await ownerPool.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2) ON CONFLICT (project_id) DO NOTHING`,
    [PROJECT, ORG],
  );
  await ownerPool.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'in_flight') ON CONFLICT (spec_id) DO NOTHING`,
    [SPEC, PROJECT, ORG],
  );
  await ownerPool.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', $5)`,
    [runId, SPEC, PROJECT, ORG, status],
  );
  await ownerPool.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
     VALUES ($1, $2, $3, 'plan', 'plan', 'running', 'answerer', 'fake', 'm') ON CONFLICT (task_id) DO NOTHING`,
    [PLAN_TASK, runId, ORG],
  );
}
