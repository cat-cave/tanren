// LOOP 3 (the loop-closing actuation) — under the AUTONOMOUS posture
// (`autonomousRemediation: true`) a BLOCKING P0/P1 scheduled-audit finding becomes a
// REMEDIATION DAG spec (re-entering the DAG as fix-it work) instead of parking at
// needs_attention — so the scheduled-audit proof "audit → finding → fix → merge"
// closes with NO operator. Contrast: under the DEFAULT (parking) posture the SAME P0
// rests `triaged` (covered in scheduledAuditsAutoRoute.test.ts). A SQL-substring stub
// pool (mirrors scheduledAuditsAutoRoute.test.ts) — TEST FIXTURE only.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { AuditsStore, runAuditJob, type AuditPassRunner } from "../src/engine/forge/audits/index.js";
import { intakeAutoRouteDeps } from "../src/engine/forge/intake/index.js";
import { AUTONOMOUS_AUDIT_POSTURE } from "../src/engine/config/index.js";
import { createDeterministicTriageAnswerer } from "./fixtures/forge/deterministicTriageAnswerer.js";

// A SQL-substring stub tracking inbox_sources + candidates + spec INSERTs, and serving
// the project `config` blob `resolveAuditPosture` reads (the AUTONOMOUS posture here).
function stubPool(projectConfig: unknown): {
  pool: pg.Pool;
  candidates: Map<string, Record<string, unknown>>;
  specInserts: Array<{ specId: string; title: string }>;
} {
  const jobs = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, Record<string, unknown>>();
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const specInserts: Array<{ specId: string; title: string }> = [];

  const candidateRow = (id: string) => ({
    ...candidates.get(id)!,
    source_name: "scheduled audits",
    source_kind: "scheduled_audit",
  });

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();

    if (sql.startsWith("INSERT INTO audit_jobs")) {
      const [id, orgId, projectId, kind, name, cadence, targetWindow, answererCli, enabled] = params as (
        | string
        | null
      )[];
      jobs.set(String(id), {
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
      });
      return { rows: [{ ...jobs.get(String(id))! }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE audit_jobs SET last_run")) {
      const j = jobs.get(String(params[0]));
      if (j === undefined) return { rows: [], rowCount: 0 };
      j.last_run = params[1];
      j.findings = JSON.parse(String(params[2]));
      return { rows: [{ ...j }], rowCount: 1 };
    }

    if (sql.includes("FROM inbox_sources WHERE org_id")) {
      const list = [...sources.values()].filter((s) => s.org_id === params[0]);
      return { rows: list, rowCount: list.length };
    }
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, , enabled, autoRoute] = params as (string | null)[];
      sources.set(String(id), {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: {},
        enabled,
        auto_route: autoRoute,
      });
      return { rows: [{ ...sources.get(String(id))! }], rowCount: 1 };
    }

    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) return { rows: [], rowCount: 0 };
    // Loop 3: the project config `resolveAuditPosture` reads to resolve the DORA knob.
    if (sql.startsWith("SELECT config FROM projects")) return { rows: [{ config: projectConfig }], rowCount: 1 };
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    if (sql.startsWith("SELECT metadata FROM specs")) return { rows: [{ metadata: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE specs SET metadata")) return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      specInserts.push({ specId: String(params[0]), title: String(params[2]) });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const existingId = byExternal.get(key);
      const cid = existingId ?? id;
      candidates.set(cid, {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status,
        triage: JSON.parse(triage),
        resolved_spec_id: null,
      });
      byExternal.set(key, cid);
      return { rows: [candidateRow(cid)], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE candidates c SET status")) {
      const [cid, status, specId] = params as (string | null)[];
      const c = candidates.get(String(cid));
      if (c === undefined) return { rows: [], rowCount: 0 };
      c.status = status;
      c.resolved_spec_id = specId;
      return { rows: [candidateRow(String(cid))], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, candidates, specInserts };
}

const findingRunner = (
  findings: { externalId: string; title: string; body: string; severity: "P0" | "P1" | "P2" | "P3" }[],
): AuditPassRunner => ({ run: async () => ({ findings }) });

describe("runAuditJob → autonomous remediation (Loop 3)", () => {
  it("under autonomousRemediation, a P0 finding becomes a REMEDIATION spec in the DAG (not parked)", async () => {
    const { pool, candidates, specInserts } = stubPool({ version: 1, auditPosture: AUTONOMOUS_AUDIT_POSTURE });
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "security",
      name: "sec",
      cadence: "nightly",
    });
    const result = await runAuditJob(
      {
        pool,
        passRunner: findingRunner([
          { externalId: "rce-uploader", title: "RCE in the uploader", body: "arbitrary code exec", severity: "P0" },
        ]),
        answerer: createDeterministicTriageAnswerer(),
        autoRoute: intakeAutoRouteDeps(),
        now: () => new Date("2026-06-04T03:00:00Z"),
      },
      job,
    );

    // The blocking P0 became a REMEDIATION spec in the DAG (the candidate accepted),
    // closing the audit→fix→merge loop — NOT parked at needs_attention.
    const cand = result.candidates[0]!;
    expect(cand.status).toBe("accepted");
    expect(cand.resolvedSpecId).toMatch(/^spec_/u);
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.title).toBe("RCE in the uploader");
    expect(candidates.size).toBe(1);
    expect(result.job.lastRun).toBe("2026-06-04T03:00:00.000Z");
  });
});
