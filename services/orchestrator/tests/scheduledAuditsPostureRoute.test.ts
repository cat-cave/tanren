// LOOP 3 dead-end 2 (Codex round-4): the `auditPosture` decision is the AUTHORITY for
// autonomous routing — NOT the triage verdict. Under `p2p3Handling: "route-to-dag"` a
// residual P2/P3 finding routes into the DAG even when triage did NOT independently mark
// it `auto_routable` (and synthesizes a finding-derived spec when triage authored none),
// so a P2/P3 never silently strands. Under the DEFAULT (`fix-if-idle`) posture the SAME
// finding still PARKS at `triaged` unless triage independently auto-routes it.
//
// A SQL-substring stub pool (mirrors scheduledAuditsRemediation.test.ts) — TEST FIXTURE
// only. The triage answerer here deliberately returns `needs_call` + a null routableSpec
// so the routing decision is driven SOLELY by the posture, not the triage verdict.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { AuditsStore, runAuditJob, type AuditPassRunner } from "../src/engine/forge/audits/index.js";
import { intakeAutoRouteDeps } from "../src/engine/forge/intake/index.js";
import { DEFAULT_AUDIT_POSTURE } from "../src/engine/config/index.js";
import type { CandidateTriage, TriageAnswerer } from "../src/engine/forge/inbox/types.js";
import { inboxSourceRow } from "./helpers/inboxSourceRow.js";

// A `route-to-dag` posture WITHOUT autonomousRemediation — isolates the residual-route
// authority from the blocking-remediation path.
const ROUTE_TO_DAG_NON_BLOCKING_POSTURE = {
  blockReviewAt: "P1" as const,
  p2p3Handling: "route-to-dag" as const,
  autonomousRemediation: false,
};

// A triage answerer that NEVER auto-routes and authors NO spec — so any routing must come
// from the posture decision alone (not the triage verdict / triage spec).
function nonRoutingTriageAnswerer(): TriageAnswerer {
  return {
    async triage(): Promise<CandidateTriage> {
      return {
        dedupe: "no match",
        match: "new behavior",
        placement: "forge proposes a new spec · placement is your call",
        verdict: "needs_call",
        duplicateOfSpecId: null,
        discoveryVariant: "feature",
        routableSpec: null,
      };
    },
  };
}

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
      sources.set(
        String(id),
        inboxSourceRow({
          id: String(id),
          orgId: String(orgId),
          projectId: projectId === null ? null : String(projectId),
          kind: kind as "scheduled_audit",
          name: String(name),
          detail: String(detail),
          config: {},
          enabled: enabled === "true",
          autoRoute: autoRoute === "true",
          state: "active",
          attention: null,
          retryNotBefore: null,
          webhookConfigured: false,
        }),
      );
      return { rows: [{ ...sources.get(String(id))! }], rowCount: 1 };
    }

    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT config FROM projects")) return { rows: [{ config: projectConfig }], rowCount: 1 };
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    if (sql.startsWith("SELECT metadata FROM specs")) return { rows: [{ metadata: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE specs SET metadata")) return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      // v68 fix: explicit org_id at $3 shifts title→$4 (params[3]).
      specInserts.push({ specId: String(params[0]), title: String(params[3]) });
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

const p2Finding = [
  {
    externalId: "missing-rate-limit",
    title: "Missing rate limit on /shorten",
    body: "no throttling",
    severity: "P2" as const,
  },
];

describe("runAuditJob → posture decision is the routing authority (Loop 3 dead-end 2)", () => {
  it("under route-to-dag, a P2/P3 residual routes to the DAG even when triage is NOT auto_routable", async () => {
    const { pool, candidates, specInserts } = stubPool({
      version: 1,
      auditPosture: ROUTE_TO_DAG_NON_BLOCKING_POSTURE,
    });
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
        passRunner: findingRunner(p2Finding),
        // The triage answerer returns needs_call + null spec — so routing is driven
        // ONLY by the posture decision, never the triage verdict.
        answerer: nonRoutingTriageAnswerer(),
        autoRoute: intakeAutoRouteDeps(),
        now: () => new Date("2026-06-04T03:00:00Z"),
      },
      job,
    );

    // The posture forced the residual into the DAG: the candidate accepted + a
    // finding-derived spec was synthesized + committed (no silent strand).
    const cand = result.candidates[0]!;
    expect(cand.status).toBe("accepted");
    expect(cand.resolvedSpecId).toMatch(/^spec_/u);
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.title).toBe("Missing rate limit on /shorten");
    expect(candidates.size).toBe(1);
  });

  it("under the DEFAULT (fix-if-idle) posture, the SAME P2 finding PARKS at triaged (not routed)", async () => {
    const { pool, candidates, specInserts } = stubPool({ version: 1, auditPosture: DEFAULT_AUDIT_POSTURE });
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
        passRunner: findingRunner(p2Finding),
        answerer: nonRoutingTriageAnswerer(),
        autoRoute: intakeAutoRouteDeps(),
        now: () => new Date("2026-06-04T03:00:00Z"),
      },
      job,
    );

    // No route-to-dag + triage not auto_routable ⇒ the finding rests `triaged` (parked),
    // and nothing was committed to the DAG.
    const cand = result.candidates[0]!;
    expect(cand.status).toBe("triaged");
    expect(cand.resolvedSpecId).toBeNull();
    expect(specInserts).toHaveLength(0);
    expect(candidates.size).toBe(1);
  });
});
