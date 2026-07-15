// the LIVE de-privilege negative proof, extracted from
// plane-split-worker.ts (file-size cap). Connects to the running stack as the
// de-privileged `tanren_dataplane` role (the SAME role the `worker` container now
// connects as after the cutover) and attempts a direct, correctly-org-scoped
// event INSERT. Migration 0031 dropped that grant, so Postgres rejects it with
// "permission denied for table events" (SQLSTATE 42501) — proving a compromised
// runner on this role can no longer forge a control-DB write. The control plane's
// own role keeps the grant (it performs the write server-side), so this is the
// data plane's dropped privilege, not the table's.

import { createDbPool } from "../../db/src/index.js";

function requiredDataPlaneUrl(): string {
  const value = process.env["TANREN_DATAPLANE_DATABASE_URL"]?.trim();
  if (value === undefined || value === "") {
    throw new Error("TANREN_DATAPLANE_DATABASE_URL is required for the exact-stack smoke");
  }
  return value;
}

/** True when the smoke should run the live de-privilege negative proof. */
export function proveDeprivilegeEnabled(): boolean {
  return process.env["TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE"] === "1";
}

export interface DeprivilegeProbeRun {
  orgId: string;
  runId: string;
  specId: string;
  projectId: string;
}

/**
 * Assert a direct `events` INSERT by the de-privileged `tanren_dataplane` role
 * is denied by Postgres for the privilege (SQLSTATE 42501). Throws if the write
 * SUCCEEDS (grant still present) or fails for any other reason.
 */
export async function proveDataPlaneWriteDenied(run: DeprivilegeProbeRun): Promise<void> {
  const dataPlane = createDbPool(requiredDataPlaneUrl());
  try {
    const client = await dataPlane.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [run.orgId]);
      await client.query(
        `INSERT INTO events (run_id, spec_id, project_id, org_id, event_type, payload)
         VALUES ($1, $2, $3, $4, 'run.started', '{}'::jsonb)`,
        [run.runId, run.specId, run.projectId, run.orgId],
      );
      await client.query("COMMIT");
      throw new Error(
        "P3b de-privilege FAILED: the tanren_dataplane role wrote an events row directly (grant present)",
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const code = (error as { code?: string }).code;
      if (code !== "42501") {
        throw error instanceof Error && /de-privilege FAILED/u.test(error.message)
          ? error
          : new Error(`P3b de-privilege: expected a permission error (42501), got ${String(code ?? error)}`);
      }
      process.stdout.write(
        `[plane-split-smoke] PROOF (P3b): a direct INSERT INTO events by the de-privileged tanren_dataplane role ` +
          `was REJECTED by Postgres (permission denied / 42501) — the write grant is gone. The data plane can write ` +
          `events/cost_records ONLY via the control plane.\n`,
      );
    } finally {
      client.release();
    }
  } finally {
    await dataPlane.end();
  }
}
