// Scheduled-audits → DAG auto-route behavior tests (the gap this PR closes).
//
// Proves that a scheduled audit run with a REAL (faked) answerer producing
// findings auto-routes each finding INTO THE DAG as a spec — not parking it in
// the inbox — and that this is idempotent (a re-run resolves the same candidate
// without a duplicate spec), and that a genuinely-empty audit is a clean pass
// (no spurious spec). The real `createAnswererPassRunner` (repo-index +
// default-branch threading + §8a loud-fail) is exercised in its own
// `answererPassRunner.test.ts`.
//
// The pool is a SQL-substring stub (mirrors intakeAutonomous.test.ts) capturing
// the candidates + the spec INSERTs so the finding → spec hand-off is observable.

import type pg from "pg";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AuditsStore, runAuditJob, type AuditPassRunner } from "../src/engine/forge/audits/index.js";
import { createAuditRoutes } from "../src/routes/audits/index.js";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { intakeAutoRouteDeps } from "../src/engine/forge/intake/index.js";
import type { TriageAnswerer } from "../src/engine/forge/inbox/types.js";
import type { SpecQualityAnswerer } from "../src/engine/forge/specQuality/index.js";
import { createDeterministicTriageAnswerer } from "./fixtures/forge/deterministicTriageAnswerer.js";

// A spec-quality validator that PERSISTENTLY rejects every spec (overall `revise`,
// every check failing). With no `reviseRoutableSpec` wired, the auto-route's gate
// exhausts its (zero) revision budget and raises `PersistentlyInvalidSpecError` — the
// loud needs_attention signal the dead-letter path catches.
const alwaysRejectsValidator: SpecQualityAnswerer = {
  validate: async () => ({
    accomplishable: { pass: false, reason: "too broad" },
    demoable: { pass: false, reason: "no observable behavior" },
    nonTrivial: { pass: false, reason: "trivial" },
    legible: { pass: false, reason: "opaque" },
    overall: "revise",
    revisionGuidance: "split + ground it",
  }),
};

// A stub pool tracking audit_jobs + inbox_sources + candidates + spec INSERTs so
// the full audit → auto-route → spec hand-off is observable.
function stubPool(existingSpecs: Array<{ spec_id: string; title: string; status: string }> = []): {
  pool: pg.Pool;
  candidates: Map<string, Record<string, unknown>>;
  specInserts: Array<{ specId: string; title: string; priority: string }>;
} {
  const jobs = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, Record<string, unknown>>();
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const specInserts: Array<{ specId: string; title: string; priority: string }> = [];

  const candidateRow = (id: string) => {
    const c = candidates.get(id)!;
    return { ...c, source_name: "scheduled audits", source_kind: "scheduled_audit" };
  };

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
    if (sql.includes("FROM audit_jobs WHERE id = $1")) {
      const j = jobs.get(String(params[0]));
      return j === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...j }], rowCount: 1 };
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

    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return { rows: existingSpecs, rowCount: existingSpecs.length };
    }
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    if (sql.startsWith("SELECT metadata FROM specs")) return { rows: [{ metadata: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE specs SET metadata")) return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      // v68 fix: explicit org_id at $3 shifts title→$4 (params[3]) + priority→$9 (params[8]).
      specInserts.push({ specId: String(params[0]), title: String(params[3]), priority: String(params[8]) });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const existingId = byExternal.get(key);
      const cid = existingId ?? id;
      const existing = existingId === undefined ? undefined : candidates.get(existingId);
      const preserveStatus =
        existing !== undefined && !["new", "triaged", "auto_routed"].includes(String(existing.status));
      candidates.set(cid, {
        ...existing,
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status: preserveStatus ? existing.status : status,
        triage: JSON.parse(triage),
        resolved_spec_id: existing?.resolved_spec_id ?? null,
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

describe("runAuditJob → DAG auto-route", () => {
  it("commits each audit finding as a spec in the DAG (not parked in the inbox)", async () => {
    const { pool, candidates, specInserts } = stubPool();
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "perf",
      name: "perf",
      cadence: "nightly",
    });
    const result = await runAuditJob(
      {
        pool,
        passRunner: findingRunner([
          { externalId: "n-plus-1-listUsers", title: "N+1 in listUsers", body: "batch the query", severity: "P2" },
        ]),
        answerer: createDeterministicTriageAnswerer(),
        autoRoute: intakeAutoRouteDeps(),
        now: () => new Date("2026-06-01T03:00:00Z"),
      },
      job,
    );

    // The finding became a SPEC in the DAG, and the candidate resolved `accepted`.
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.title).toBe("N+1 in listUsers");
    expect(specInserts[0]!.priority).toBe("P2");
    const cand = result.candidates[0]!;
    expect(cand.status).toBe("accepted");
    expect(cand.resolvedSpecId).toMatch(/^spec_/u);
    expect(candidates.size).toBe(1);
  });

  it("is idempotent — re-running the same audit does not duplicate the spec", async () => {
    const { pool, candidates, specInserts } = stubPool();
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "security",
      name: "sec",
      cadence: "nightly",
    });
    const deps = {
      pool,
      passRunner: findingRunner([
        // P2 (moderate) — below the default posture's P1 block threshold ⇒ NON-blocking
        // ⇒ routes into the DAG (the idempotency this test asserts is about the routed spec).
        { externalId: "injection-login", title: "Injection in login", body: "param it", severity: "P2" },
      ]),
      answerer: createDeterministicTriageAnswerer(),
      autoRoute: intakeAutoRouteDeps(),
    };
    await runAuditJob(deps, job);
    await runAuditJob(deps, job);
    // One candidate (idempotent on (source_id, external_id)). The re-run upserts
    // the same candidate; no second spec is created for the same finding.
    expect(candidates.size).toBe(1);
    expect(specInserts).toHaveLength(1);
  });

  it("grounds audit triage in the project's existing specs", async () => {
    const seenExistingSpecs: Array<{ specId: string; title: string; status: string }> = [];
    const { pool } = stubPool([{ spec_id: "spec_existing", title: "existing audit fix", status: "merged" }]);
    const deterministic = createDeterministicTriageAnswerer();
    const answerer: TriageAnswerer = {
      triage: async (context) => {
        seenExistingSpecs.push(...context.existingSpecs);
        return deterministic.triage(context);
      },
    };
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "security",
      name: "sec",
      cadence: "nightly",
    });

    await runAuditJob(
      {
        pool,
        passRunner: findingRunner([
          { externalId: "existing-audit-fix", title: "Existing audit fix", body: "already fixed", severity: "P2" },
        ]),
        answerer,
      },
      job,
    );

    expect(seenExistingSpecs).toEqual([{ specId: "spec_existing", title: "existing audit fix", status: "merged" }]);
  });

  it("a genuinely-empty audit is a clean pass with no spec", async () => {
    const { pool, specInserts, candidates } = stubPool();
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "deps",
      name: "deps",
      cadence: "nightly",
    });
    const result = await runAuditJob(
      {
        pool,
        passRunner: findingRunner([]),
        answerer: createDeterministicTriageAnswerer(),
        autoRoute: intakeAutoRouteDeps(),
      },
      job,
    );
    expect(specInserts).toHaveLength(0);
    expect(candidates.size).toBe(0);
    expect(result.job.findings.severity).toBe("ok");
    expect(result.job.lastRun).not.toBeNull();
  });

  // LOOP 3 (a): a BLOCKING finding (≥ the posture `blockReviewAt`) routes through the SAME
  // P0–P3/auditPosture path as inline audits — ESCALATED to needs_attention (`triaged`), NOT
  // auto-routed. The default posture (`blockReviewAt: P1`) blocks on a P0 ⇒ never a spec.
  it("a P0 finding routes via auditPosture → ESCALATED to needs_attention (triaged), not auto-routed", async () => {
    const { pool, candidates, specInserts } = stubPool();
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
        now: () => new Date("2026-06-02T03:00:00Z"),
      },
      job,
    );

    // A P0 (≥ blockReviewAt) BLOCKS: the candidate rests `triaged` (needs_attention),
    // and NO spec was committed to the DAG.
    const cand = result.candidates[0]!;
    expect(cand.status).toBe("triaged");
    expect(specInserts).toHaveLength(0);
    expect(candidates.size).toBe(1);
    // The tick still completes + records the run (last_run stamped, findings rolled up).
    expect(result.job.lastRun).toBe("2026-06-02T03:00:00.000Z");
    // P0 ⇒ surface tone `fail`.
    expect(result.job.findings.severity).toBe("fail");
  });

  // LOOP 3 (b): a throwing auto-route (`PersistentlyInvalidSpecError`) DEAD-LETTERS the
  // candidate to needs_attention AND still records the run — so the next tick does NOT
  // re-run + re-spend on the same persistently-broken spec FOREVER.
  it("a throwing auto-route DEAD-LETTERS the candidate + records the run (no infinite re-spend)", async () => {
    const { pool, specInserts } = stubPool();
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "perf",
      name: "perf",
      cadence: "nightly",
    });
    const result = await runAuditJob(
      {
        pool,
        // A NON-blocking P2 finding so it reaches the auto-route path; the validator then
        // rejects its spec persistently.
        passRunner: findingRunner([{ externalId: "n-plus-1", title: "N+1 query", body: "batch it", severity: "P2" }]),
        answerer: createDeterministicTriageAnswerer(),
        // Wire the persistently-rejecting validator so autoRouteCandidate throws
        // PersistentlyInvalidSpecError (no reviseRoutableSpec ⇒ zero revision budget).
        autoRoute: intakeAutoRouteDeps({ resolveSpecValidator: () => alwaysRejectsValidator }),
        now: () => new Date("2026-06-03T03:00:00Z"),
      },
      job,
    );

    // The candidate was DEAD-LETTERED to `triaged` (needs_attention), NOT left dangling
    // at `auto_routed`, and NO spec was committed.
    const cand = result.candidates[0]!;
    expect(cand.status).toBe("triaged");
    expect(specInserts).toHaveLength(0);
    // CRUCIAL: the run was STILL recorded — last_run stamped — so the next tick won't
    // re-run this same job and re-spend on the same broken spec.
    expect(result.job.lastRun).toBe("2026-06-03T03:00:00.000Z");
  });
});

// ── The manual POST …/audits/:jobId/run route ───────────────────────────────

const adminActor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

describe("POST /:orgId/audits/:jobId/run", () => {
  it("uses the injected pass runner + auto-routes the finding into the DAG", async () => {
    const { pool, candidates, specInserts } = stubPool();
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "perf",
      name: "perf",
      cadence: "nightly",
    });

    const app = new Hono<ActorContextEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", adminActor);
      await next();
    });
    app.route(
      "/orgs",
      createAuditRoutes({
        pool,
        passRunner: findingRunner([
          { externalId: "slow-render", title: "slow render path", body: "memoize it", severity: "P2" },
        ]),
        answererFactory: () => createDeterministicTriageAnswerer(),
      }),
    );

    const res = await app.request(`/orgs/org_a/audits/${job.id}/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ status: string; resolvedSpecId: string | null }> };
    // The finding routed all the way to a spec (status accepted + a spec INSERT).
    expect(body.candidates[0]!.status).toBe("accepted");
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.title).toBe("slow render path");
    expect(candidates.size).toBe(1);
  });
});
