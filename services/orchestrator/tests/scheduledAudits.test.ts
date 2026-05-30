// P3-0021 scheduled-audits engine tests.
//
// Exercises the scheduler (a MOCKED read-only pass → findings → candidate
// inbox auto-route), the enable/disable toggle + run recording, the store
// round-trip, and the forge-recommended coverage diff. The pool is a
// lightweight in-memory stub keyed by SQL substring, mirroring the
// candidateInbox.test pattern — no provider, no SSH, no real Postgres.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  createAuditJob,
  listAuditJobs,
  recommendCoverage,
  runAuditJob,
  setAuditJobEnabled,
  summarizeFindings,
  type AuditJob,
  type AuditPassRunner,
} from "../src/engine/forge/audits/index.js";

// In-memory pool tracking audit_jobs + inbox_sources + candidates so the
// run → emit-to-inbox round trip is observable.
function stubPool(): {
  pool: pg.Pool;
  jobs: Map<string, Record<string, unknown>>;
  sources: Map<string, Record<string, unknown>>;
  candidates: Map<string, Record<string, unknown>>;
} {
  const jobs = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, Record<string, unknown>>();
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();

  const jobRow = (id: string) => ({ ...jobs.get(id)! });
  const sourceRow = (id: string) => ({ ...sources.get(id)! });

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/g, " ").trim();

    // ---- audit_jobs ----
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
      return { rows: [jobRow(String(id))], rowCount: 1 };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM audit_jobs WHERE org_id")) {
      const list = [...jobs.values()].filter((j) => j.org_id === params[0]);
      return { rows: list, rowCount: list.length };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM audit_jobs WHERE id = $1")) {
      const j = jobs.get(String(params[0]));
      return j === undefined ? { rows: [], rowCount: 0 } : { rows: [jobRow(String(params[0]))], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE audit_jobs SET enabled")) {
      const j = jobs.get(String(params[0]));
      if (j === undefined) return { rows: [], rowCount: 0 };
      j.enabled = params[1];
      return { rows: [jobRow(String(params[0]))], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE audit_jobs SET last_run")) {
      const j = jobs.get(String(params[0]));
      if (j === undefined) return { rows: [], rowCount: 0 };
      j.last_run = params[1];
      j.findings = JSON.parse(String(params[2]));
      return { rows: [jobRow(String(params[0]))], rowCount: 1 };
    }

    // ---- inbox_sources (find-or-create the scheduled-audit system source) ----
    if (sql.startsWith("SELECT") && sql.includes("FROM inbox_sources WHERE org_id")) {
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
      return { rows: [sourceRow(String(id))], rowCount: 1 };
    }

    // ---- candidates (upsert from the audit findings) ----
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO candidates")) {
      const [
        id,
        sourceId,
        orgId,
        projectId,
        externalId,
        title,
        body,
        severity,
        status,
        triage,
        sourceName,
        sourceKind,
      ] = params as (string | null)[];
      const key = `${sourceId}::${externalId}`;
      const cid = byExternal.get(key) ?? String(id);
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
        triage: JSON.parse(String(triage)),
        resolved_spec_id: null,
        source_name: sourceName,
        source_kind: sourceKind,
      });
      byExternal.set(key, cid);
      return { rows: [candidates.get(cid)!], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query } as unknown as pg.Pool, jobs, sources, candidates };
}

const fakeRunner = (
  findings: {
    externalId: string;
    title: string;
    body: string;
    severity: "info" | "warn" | "fail";
  }[],
): AuditPassRunner => ({
  run: async () => ({ findings }),
});

describe("audit job store", () => {
  it("creates and lists jobs with the enable toggle", async () => {
    const { pool } = stubPool();
    const job = await createAuditJob(pool, {
      orgId: "org_a",
      projectId: null,
      kind: "security",
      name: "security scan",
      cadence: "nightly",
      targetWindow: "night (00–05)",
      answererCli: "claude · haiku-4.5",
    });
    expect(job.id).toMatch(/^audit_/);
    expect(job.enabled).toBe(true);
    const listed = await listAuditJobs(pool, "org_a");
    expect(listed).toHaveLength(1);

    const paused = await setAuditJobEnabled(pool, job.id, false);
    expect(paused?.enabled).toBe(false);
  });
});

describe("runAuditJob → candidate inbox auto-route", () => {
  it("runs the pass, emits each finding as an auto_routed candidate, and records the run", async () => {
    const { pool, sources, candidates } = stubPool();
    const job = await createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "a11y",
      name: "a11y",
      cadence: "weekly",
    });
    const runner = fakeRunner([
      {
        externalId: "a11y-1",
        title: "contrast failure on nav",
        body: "3.1:1 below WCAG AA",
        severity: "warn",
      },
    ]);

    const result = await runAuditJob({ pool, passRunner: runner, now: () => new Date("2026-05-28T03:00:00Z") }, job);

    // The system scheduled-audit source was created + the finding routed through it.
    expect([...sources.values()].some((s) => s.kind === "scheduled_audit" && s.auto_route === "true")).toBe(true);
    expect(result.candidates).toHaveLength(1);
    const cand = result.candidates[0]!;
    expect(cand.status).toBe("auto_routed");
    expect(cand.triage?.verdict).toBe("auto_routable");
    expect(cand.sourceKind).toBe("scheduled_audit");
    // externalId namespaced by job id so re-runs are idempotent in the inbox.
    expect(cand.externalId).toBe(`${job.id}:a11y-1`);
    expect(candidates.size).toBe(1);

    // The run was recorded on the job: last_run stamped, findings rolled up.
    expect(result.job.lastRun).toBe("2026-05-28T03:00:00.000Z");
    expect(result.job.findings.count).toBe(1);
    expect(result.job.findings.severity).toBe("warn");
  });

  it("re-running the same job updates rather than duplicates the candidate", async () => {
    const { pool, candidates } = stubPool();
    const job = await createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "deps",
      name: "deps",
      cadence: "nightly",
    });
    const runner = fakeRunner([{ externalId: "dep-1", title: "lodash outdated", body: "v1", severity: "info" }]);
    const deps = { pool, passRunner: runner };
    await runAuditJob(deps, job);
    await runAuditJob(deps, job);
    expect(candidates.size).toBe(1);
  });

  it("a disabled job is a no-op (no findings emitted, no run recorded)", async () => {
    const { pool, candidates } = stubPool();
    const job = await createAuditJob(pool, {
      orgId: "org_a",
      projectId: null,
      kind: "perf",
      name: "perf",
      cadence: "monthly",
    });
    const paused: AuditJob = { ...job, enabled: false };
    const runner = fakeRunner([{ externalId: "p-1", title: "regression", body: "", severity: "warn" }]);
    const result = await runAuditJob({ pool, passRunner: runner }, paused);
    expect(result.candidates).toHaveLength(0);
    expect(candidates.size).toBe(0);
  });

  it("a clean pass (no findings) records a clean run with no candidates", async () => {
    const { pool, candidates } = stubPool();
    const job = await createAuditJob(pool, {
      orgId: "org_a",
      projectId: null,
      kind: "security",
      name: "sec",
      cadence: "nightly",
    });
    const result = await runAuditJob({ pool, passRunner: fakeRunner([]) }, job);
    expect(result.candidates).toHaveLength(0);
    expect(candidates.size).toBe(0);
    expect(result.job.findings.severity).toBe("ok");
    expect(result.job.lastRun).not.toBeNull();
  });
});

describe("summarizeFindings", () => {
  it("rolls up to the worst severity", () => {
    const s = summarizeFindings([
      { externalId: "1", title: "a", body: "", severity: "info" },
      { externalId: "2", title: "b", body: "", severity: "fail" },
    ]);
    expect(s.count).toBe(2);
    expect(s.severity).toBe("fail");
  });
});

describe("recommendCoverage", () => {
  it("recommends only kinds the org has no enabled job for", () => {
    const jobs: AuditJob[] = [
      {
        id: "audit_1",
        orgId: "org_a",
        projectId: null,
        kind: "security",
        name: "sec",
        cadence: "nightly",
        targetWindow: "",
        answererCli: "",
        enabled: true,
        lastRun: null,
        findings: { count: 0, severity: "ok", note: "" },
      },
    ];
    const recs = recommendCoverage(jobs);
    expect(recs.some((r) => r.kind === "security")).toBe(false);
    expect(recs.some((r) => r.kind === "perf")).toBe(true);
  });
});
