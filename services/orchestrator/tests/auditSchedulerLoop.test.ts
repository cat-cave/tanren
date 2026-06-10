// P1d — the scheduled-audit scheduler ON A LOOP (autonomy-engine.md §1d: "The
// audit scheduler currently isn't on a loop — put it on one."). Pins the cadence
// due-logic and that a tick runs every due job through `runAuditJob` (findings
// auto-route into the inbox), skipping not-yet-due and disabled jobs.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { AuditSchedulerLoop, isAuditJobDue } from "../src/engine/forge/audits/index.js";
import type { AuditJob, AuditPassRunner } from "../src/engine/forge/audits/index.js";
import { createDeterministicTriageAnswerer } from "./fixtures/forge/deterministicTriageAnswerer.js";

const NOW = Date.parse("2026-06-01T12:00:00Z");

function job(overrides: Partial<AuditJob>): AuditJob {
  return {
    id: "audit_1",
    orgId: "org_a",
    projectId: "project_a",
    kind: "security",
    name: "nightly security",
    cadence: "nightly",
    targetWindow: "",
    answererCli: "",
    enabled: true,
    lastRun: null,
    findings: { count: 0, severity: "ok", note: "" },
    ...overrides,
  };
}

describe("isAuditJobDue", () => {
  it("is due when never run", () => {
    expect(isAuditJobDue(job({ lastRun: null }), NOW)).toBe(true);
  });
  it("is not due before the cadence window elapses", () => {
    // 1 minute ago, against a nightly cadence.
    const lastRun = new Date(NOW - 60_000).toISOString();
    expect(isAuditJobDue(job({ lastRun }), NOW)).toBe(false);
  });
  it("is due once the cadence window elapses", () => {
    // 25 hours ago — past the nightly (24h) window.
    const lastRun = new Date(NOW - 25 * 60 * 60_000).toISOString();
    expect(isAuditJobDue(job({ lastRun }), NOW)).toBe(true);
  });
  it("is never due while disabled", () => {
    expect(isAuditJobDue(job({ enabled: false, lastRun: null }), NOW)).toBe(false);
  });
});

// A stub pool exposing one due audit job + the inbox upsert path so the tick's
// findings → candidate hand-off is observable.
function stubPool(jobRowOverrides: Record<string, unknown>): {
  pool: pg.Pool;
  candidates: Map<string, Record<string, unknown>>;
  scopedSpecReadOrgIds: string[];
} {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const scopedSpecReadOrgIds: string[] = [];
  let transactionOrgId: string | null = null;
  const jobRow = {
    id: "audit_1",
    org_id: "org_a",
    project_id: "project_a",
    kind: "security",
    name: "nightly security",
    cadence: "nightly",
    target_window: "",
    answerer_cli: "",
    enabled: "true",
    last_run: null,
    findings: { count: 0, severity: "ok", note: "" },
    ...jobRowOverrides,
  };
  const sources = new Map<string, Record<string, unknown>>();
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    const orgScope = sql.match(/^SET LOCAL app\.current_org_id = '([^']+)'$/u);
    if (orgScope !== null) {
      transactionOrgId = orgScope[1]!;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      transactionOrgId = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "BEGIN") return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT DISTINCT org_id FROM audit_jobs")) return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    if (sql.includes("FROM audit_jobs WHERE org_id = $1")) return { rows: [jobRow], rowCount: 1 };
    if (sql.includes("FROM inbox_sources WHERE org_id = $1")) {
      return { rows: [...sources.values()], rowCount: sources.size };
    }
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, , enabled, autoRoute] = params as (string | null)[];
      const row = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: {},
        enabled,
        auto_route: autoRoute,
      };
      sources.set(String(id), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      if (transactionOrgId !== "org_a") {
        throw new Error(`unscoped audit existing-spec read: ${transactionOrgId ?? "none"}`);
      }
      scopedSpecReadOrgIds.push(transactionOrgId);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const cid = byExternal.get(key) ?? id;
      candidates.set(cid, { id: cid, status, external_id: externalId, title, triage: JSON.parse(triage) });
      byExternal.set(key, cid);
      return {
        rows: [
          {
            ...candidates.get(cid),
            source_id: sourceId,
            org_id: orgId,
            project_id: projectId,
            body,
            severity,
            resolved_spec_id: null,
            source_name: "scheduled audits",
            source_kind: "scheduled_audit",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE audit_jobs SET")) {
      return { rows: [{ ...jobRow, last_run: new Date().toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, candidates, scopedSpecReadOrgIds };
}

const oneFindingRunner: AuditPassRunner = {
  run: async () => ({
    findings: [{ externalId: "f1", title: "missing index", body: "add an index", severity: "P2" }],
  }),
};

describe("AuditSchedulerLoop.tick", () => {
  it("runs a due job and auto-routes its finding into the inbox", async () => {
    const { pool, candidates, scopedSpecReadOrgIds } = stubPool({ last_run: null });
    const loop = new AuditSchedulerLoop({
      pool,
      passRunner: oneFindingRunner,
      answererFactory: () => createDeterministicTriageAnswerer(),
      now: () => NOW,
    });
    const ran = await loop.tick();
    expect(ran).toHaveLength(1);
    // The finding became an auto_routed candidate on the scheduled-audit source.
    const cand = [...candidates.values()][0];
    expect(cand?.status).toBe("auto_routed");
    expect(scopedSpecReadOrgIds).toEqual(["org_a"]);
  });

  it("skips a not-yet-due job (no run)", async () => {
    const recent = new Date(NOW - 60_000).toISOString();
    const { pool } = stubPool({ last_run: recent });
    const loop = new AuditSchedulerLoop({
      pool,
      passRunner: oneFindingRunner,
      answererFactory: () => createDeterministicTriageAnswerer(),
      now: () => NOW,
    });
    expect(await loop.tick()).toHaveLength(0);
  });
});
