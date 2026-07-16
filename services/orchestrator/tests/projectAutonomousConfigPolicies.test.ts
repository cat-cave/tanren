// PROJECT-CONFIG-IS-THE-SOURCE-OF-TRUTH (the apex-mode eradication PR). The autonomy
// knobs that used to flip on `TANREN_APEX_MODE=1` at boot — the autonomous audit
// posture + the lowered CI-intelligence flaky-recurrence bar — are now governed
// SETTINGS on the project config jsonb, configured over the SAME governance API
// (`PUT /:orgId/projects/:projectId/governance`) any operator uses. Tanren the
// codebase has no apex branch.
//
// These tests assert the four contractual properties of that move:
//   (1) the governance PUT accepts both `auditPosture` and `insightThresholds` and
//       round-trips through `migrateProjectConfig` cleanly.
//   (2) after the PUT, the scheduled-audit posture helper returns the configured
//       AUTONOMOUS posture for that project; an unconfigured project keeps BALANCED.
//   (3) the audit-posture preflight PASSES for `{ autonomous: true, posture: AUTONOMOUS }`
//       and FAILS LOUD for `{ autonomous: true, posture: BALANCED }`.
//   (4) `emitCiInsightCandidates` with `deps.thresholds = { ciInsightFlakyMinShas: 1 }`
//       ships a fix-spec on a single-SHA flake; the absent-override default (2) does not.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { runWithJobOrgId } from "@tanren/db";
import { AUTONOMOUS_AUDIT_POSTURE, DEFAULT_AUDIT_POSTURE, migrateProjectConfig } from "../src/engine/config/index.js";
import { resolveAuditPostureForProject } from "../src/engine/forge/audits/scheduler.js";
import {
  assertAuditPostureReentersFindings,
  AuditPostureStrandsFindingsError,
} from "../src/engine/workflow/auditPosturePreflight.js";
import { GovernancePutSchema } from "../src/routes/projects/governance.js";
import { emitCiInsightCandidates } from "../src/engine/insights/ciInsightsCandidates.js";
import { intakeAutoRouteDeps } from "../src/engine/forge/intake/index.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";
import type { CandidateTriage, TriageAnswerer, TriageRoutableSpec } from "../src/engine/forge/inbox/index.js";

const ORG = "org_a";
const PROJECT = "proj_a";
const NOW = new Date("2026-05-20T00:00:00Z");

function noopAppend(): AppendEvent {
  return async () => {};
}

function fixedTriage(routableSpec: TriageRoutableSpec | null): TriageAnswerer {
  return {
    async triage(): Promise<CandidateTriage> {
      return {
        dedupe: "no match",
        match: "ci root cause",
        placement: "auto",
        verdict: "auto_routable",
        duplicateOfSpecId: null,
        discoveryVariant: "bug",
        routableSpec,
      };
    },
  };
}

const fixSpec: TriageRoutableSpec = {
  title: "Fix the race in suite.flaky",
  description: "Isolate the shared fixture and inject a deterministic clock.",
  acceptanceCriteria: ["fixture isolated", "clock injected"],
  dependsOn: [],
  priority: "P1",
};

interface TestRowSeed {
  test_id: string;
  head_sha: string;
  outcome: string;
  duration_ms: number | null;
  retries: number;
  suite: string | null;
  observed_at: Date;
}

// SQL-substring stub pool — mirrors ciInsightsGenerative.test.ts (the established
// pattern). Tracks ci_test_results (read), inbox_sources, candidates upsert/lookup,
// and the spec INSERT (the DAG ship) so a successful emit increments `specInserts`.
function stubPool(testRows: TestRowSeed[]): {
  pool: pg.Pool;
  specInserts: Array<{ specId: string; title: string }>;
} {
  const sources = new Map<string, Record<string, unknown>>();
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const specInserts: Array<{ specId: string; title: string }> = [];

  const candidateRow = (id: string): Record<string, unknown> => {
    const c = candidates.get(id)!;
    const src = sources.get(String(c.source_id))!;
    return { ...c, source_name: src.name, source_kind: src.kind };
  };

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.includes("FROM ci_test_results")) {
      const since = params[1] as Date;
      const rows = testRows
        .filter((r) => r.observed_at.getTime() >= since.getTime())
        .map((r) => ({
          test_id: r.test_id,
          file: null,
          suite: r.suite,
          head_sha: r.head_sha,
          outcome: r.outcome,
          duration_ms: r.duration_ms,
          retries: r.retries,
          observed_at: r.observed_at,
        }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM inbox_sources WHERE org_id = $1")) {
      const list = [...sources.values()].filter((s) => s.org_id === params[0]);
      return { rows: list, rowCount: list.length };
    }
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, config, enabled, autoRoute] = params as (string | null)[];
      sources.set(String(id), {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: JSON.parse(String(config)),
        enabled,
        auto_route: autoRoute,
      });
      return { rows: [{ ...sources.get(String(id))! }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT external_id, status FROM candidates")) {
      const rows = [...candidates.values()]
        .filter((c) => c.source_id === params[0])
        .map((c) => ({ external_id: c.external_id, status: c.status }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const existing = byExternal.get(key);
      const cid = existing ?? id;
      const prior = existing === undefined ? undefined : candidates.get(cid);
      const keep = ["new", "triaged", "auto_routed"];
      const nextStatus = prior !== undefined && !keep.includes(String(prior.status)) ? prior.status : status;
      candidates.set(cid, {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status: nextStatus,
        triage: JSON.parse(triage),
        resolved_spec_id: prior?.resolved_spec_id ?? null,
      });
      byExternal.set(key, cid);
      return { rows: [candidateRow(cid)], rowCount: 1 };
    }
    if (sql.startsWith("SELECT c.id, c.source_id") && sql.includes("WHERE c.id = $1")) {
      const c = candidates.get(String(params[0]));
      return c === undefined ? { rows: [], rowCount: 0 } : { rows: [candidateRow(String(params[0]))], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE candidates c SET status")) {
      const [cid, status, specId] = params as (string | null)[];
      const c = candidates.get(String(cid));
      if (c === undefined) return { rows: [], rowCount: 0 };
      c.status = status;
      c.resolved_spec_id = specId;
      return { rows: [candidateRow(String(cid))], rowCount: 1 };
    }
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: ORG }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      specInserts.push({ specId: String(params[0]), title: String(params[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT metadata FROM specs")) return { rows: [{ metadata: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE specs SET metadata")) return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, specInserts };
}

// Minimal stub pool that returns the seeded blob from `projects.config` for
// `ProjectStore.getConfig` (the SQL projects `config` from `projects`). Used by
// (2) — the scheduled-audit posture helper resolution.
function poolReturningConfig(config: unknown): pg.Pool {
  const query = async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.includes("FROM projects") && sql.includes("config")) {
      return { rows: [{ config }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query } as unknown as pg.Pool;
}

function flakyRowsOnOneSha(): TestRowSeed[] {
  // A flake toggled on a SINGLE SHA (both pass and fail on the same head SHA). Below
  // the default 2-SHA bar; at or above the autonomous-project 1-SHA override.
  return [
    {
      test_id: "suite.flaky",
      head_sha: "sha0",
      outcome: "passed",
      duration_ms: 100,
      retries: 0,
      suite: "unit",
      observed_at: new Date(NOW.getTime() - 1000),
    },
    {
      test_id: "suite.flaky",
      head_sha: "sha0",
      outcome: "failed",
      duration_ms: 100,
      retries: 0,
      suite: "unit",
      observed_at: new Date(NOW.getTime() - 1000),
    },
  ];
}

describe("project-config is the source of truth (apex-mode eradication)", () => {
  describe("(1) GovernancePutSchema accepts auditPosture + insightThresholds and round-trips", () => {
    it("a PUT body carrying both fields parses + the migrated config persists both", () => {
      const parsed = GovernancePutSchema.parse({
        revision: "1",
        auditPosture: AUTONOMOUS_AUDIT_POSTURE,
        insightThresholds: { ciInsightFlakyMinShas: 1 },
      });
      expect(parsed.auditPosture).toEqual(AUTONOMOUS_AUDIT_POSTURE);
      expect(parsed.insightThresholds).toEqual({ ciInsightFlakyMinShas: 1 });

      // Round-trip through the versioned parser exactly as handleGovernancePut does.
      const config = migrateProjectConfig({
        version: 1,
        auditPosture: parsed.auditPosture,
        insightThresholds: parsed.insightThresholds,
      });
      expect(config.auditPosture).toEqual(AUTONOMOUS_AUDIT_POSTURE);
      expect(config.insightThresholds).toEqual({ ciInsightFlakyMinShas: 1 });
    });

    it("rejects an unknown field (strict shape)", () => {
      const result = GovernancePutSchema.safeParse({ unknown: "field" });
      expect(result.success).toBe(false);
    });
  });

  describe("(2) the scheduled-audit posture helper returns the persisted project posture", () => {
    it("an UNCONFIGURED project (absent config) resolves to the BALANCED default", async () => {
      // Version-less blob — the project never wrote its own posture.
      const pool = poolReturningConfig({});
      const posture = await resolveAuditPostureForProject(pool, PROJECT);
      expect(posture).toEqual(DEFAULT_AUDIT_POSTURE);
    });

    it("a project that PUT auditPosture: AUTONOMOUS resolves to AUTONOMOUS", async () => {
      const pool = poolReturningConfig({ version: 1, auditPosture: AUTONOMOUS_AUDIT_POSTURE });
      const posture = await resolveAuditPostureForProject(pool, PROJECT);
      expect(posture).toEqual(AUTONOMOUS_AUDIT_POSTURE);
    });

    it("a project-less (null projectId) job falls through to the BALANCED default", async () => {
      const pool = poolReturningConfig(null);
      const posture = await resolveAuditPostureForProject(pool, null);
      expect(posture).toEqual(DEFAULT_AUDIT_POSTURE);
    });
  });

  describe("(3) the audit-posture preflight is the fail-closed bar", () => {
    it("PASSES for an autonomous run on the AUTONOMOUS posture", async () => {
      await expect(
        assertAuditPostureReentersFindings({ autonomous: true, posture: AUTONOMOUS_AUDIT_POSTURE }, noopAppend()),
      ).resolves.toBeUndefined();
    });

    it("FAILS LOUD for an autonomous run on the BALANCED default (the misconfigured-project case)", async () => {
      await expect(
        assertAuditPostureReentersFindings({ autonomous: true, posture: DEFAULT_AUDIT_POSTURE }, noopAppend()),
      ).rejects.toBeInstanceOf(AuditPostureStrandsFindingsError);
    });
  });

  describe("(4) emitCiInsightCandidates honors deps.thresholds (the per-project override)", () => {
    async function emit(pool: pg.Pool, thresholds?: { ciInsightFlakyMinShas: number }) {
      return runWithJobOrgId(ORG, () =>
        emitCiInsightCandidates({
          pool,
          projectId: PROJECT,
          orgId: ORG,
          answerer: fixedTriage(fixSpec),
          autoRoute: intakeAutoRouteDeps(),
          now: NOW,
          ...(thresholds !== undefined && { thresholds }),
        }),
      );
    }

    it("a single-SHA flake DOES NOT ship a fix-spec at the default 2-SHA bar", async () => {
      const { pool, specInserts } = stubPool(flakyRowsOnOneSha());
      const { candidates } = await emit(pool);
      expect(candidates).toHaveLength(0);
      expect(specInserts).toHaveLength(0);
    });

    it("a single-SHA flake DOES ship a fix-spec under deps.thresholds = { ciInsightFlakyMinShas: 1 }", async () => {
      const { pool, specInserts } = stubPool(flakyRowsOnOneSha());
      const { candidates } = await emit(pool, { ciInsightFlakyMinShas: 1 });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.externalId).toBe("ci-flaky:suite.flaky");
      expect(specInserts).toHaveLength(1);
    });
  });

  // ── (5) REMOVED ── the Lane T1 template-build child-project case is gone
  // along with the entire `template_build` scaffoldOrigin and the agent-driven
  // template-build DAG (docs/roadmap/templating-system.md doctrine collapse):
  // there is no synthetic template-creation derive inside a derive any more —
  // every project DAG seeds from a fragment-composed template via the single
  // `selectFragmentConfig` path. The persisted-config marker `templateBuild` is
  // removed from `ProjectConfigV1` and no longer needs covering.
});
