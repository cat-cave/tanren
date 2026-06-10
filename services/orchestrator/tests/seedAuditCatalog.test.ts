// PROJECT-BOOTSTRAP audit seed (Loop 3 dead-end 1, Codex round-4): a fresh autonomous
// project must be seeded with the standard scheduled-audit catalog, else the audit loop
// (which only runs EXISTING `audit_jobs` rows) NEVER runs on it. These prove: the seed
// creates the security/deps/mutation/stale_specs catalog; it is idempotent (re-provision
// adds nothing); and the audit loop's due-check picks the seeded jobs up (first pass).
//
// A SQL-substring stub pool over `audit_jobs` — TEST FIXTURE only.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  AUDIT_BOOTSTRAP_CATALOG,
  isAuditJobDue,
  seedAuditCatalog,
  type AuditJob,
} from "../src/engine/forge/audits/index.js";

function stubPool(): { pool: pg.Pool; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO audit_jobs")) {
      const [id, orgId, projectId, kind, name, cadence, targetWindow, answererCli, enabled] = params as (
        | string
        | null
      )[];
      const row = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        cadence,
        target_window: targetWindow,
        answerer_cli: answererCli,
        enabled,
        last_run: null,
        findings: { count: 0, severity: "ok", note: "" },
        created_at: seq++,
      };
      rows.set(String(id), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM audit_jobs WHERE org_id")) {
      const list = [...rows.values()]
        .filter((r) => r.org_id === params[0])
        .sort((a, b) => Number(a.created_at) - Number(b.created_at));
      return { rows: list, rowCount: list.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, rows };
}

describe("seedAuditCatalog (project-bootstrap audit seed)", () => {
  it("seeds the standard security/deps/mutation/stale_specs catalog for a fresh project", async () => {
    const { pool } = stubPool();
    const result = await seedAuditCatalog({ client: pool, orgId: "org_a", projectId: "project_a" });

    expect(result.created.sort()).toEqual(["deps", "mutation", "security", "stale_specs"]);
    expect(result.jobs).toHaveLength(AUDIT_BOOTSTRAP_CATALOG.length);
    expect(new Set(result.jobs.map((j) => j.kind))).toEqual(new Set(["security", "deps", "mutation", "stale_specs"]));
    // Cadences mirror the recommended coverage set.
    const byKind = new Map(result.jobs.map((j) => [j.kind, j]));
    expect(byKind.get("security")!.cadence).toBe("nightly");
    expect(byKind.get("deps")!.cadence).toBe("nightly");
    expect(byKind.get("mutation")!.cadence).toBe("weekly");
    expect(byKind.get("stale_specs")!.cadence).toBe("monthly");
  });

  it("is idempotent — a re-provision adds nothing", async () => {
    const { pool, rows } = stubPool();
    await seedAuditCatalog({ client: pool, orgId: "org_a", projectId: "project_a" });
    const second = await seedAuditCatalog({ client: pool, orgId: "org_a", projectId: "project_a" });

    expect(second.created).toEqual([]);
    expect(second.jobs).toHaveLength(AUDIT_BOOTSTRAP_CATALOG.length);
    expect(rows.size).toBe(AUDIT_BOOTSTRAP_CATALOG.length);
  });

  it("the audit loop picks the seeded jobs up — each is DUE on its first pass", async () => {
    const { pool } = stubPool();
    const result = await seedAuditCatalog({ client: pool, orgId: "org_a", projectId: "project_a" });
    const now = Date.now();
    // Every freshly-seeded job has no lastRun, so the loop's due-check fires immediately.
    for (const job of result.jobs as AuditJob[]) {
      expect(isAuditJobDue(job, now)).toBe(true);
    }
  });
});
