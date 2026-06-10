// CI-intelligence PR3 — the GENERATIVE loop. A recurring CI signal (a proven-flaky
// test / a slow suite) becomes an auto-routed CI-insights candidate → root-cause
// triage → a fix-spec shipped through the inbox auto-route spine. These tests drive
// the real emitter (`emitCiInsightCandidates`) over a SQL-substring stub pool
// (mirroring intakeAutonomous.test.ts), proving:
//   • a flaky signal >= the recurrence threshold → an auto-routed `ci-flaky:<id>`
//     candidate + a spec; below threshold → no candidate (anti-spam);
//   • a re-run → no duplicate candidate, no second spec (idempotent + open-dedupe);
//   • a slow-suite signal → an auto-routed `ci-slow:<suite>` candidate + a spec;
//   • a CI insight whose triage finds no clear fix → `needs_call` (inbox), no spec.
// Plus a prompt-builder test: the root-cause branch renders the evidence + asks WHY.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { runWithJobOrgId } from "@tanren/db";
import { emitCiInsightCandidates } from "../src/engine/insights/ciInsightsCandidates.js";
import { intakeAutoRouteDeps } from "../src/engine/forge/intake/index.js";
import { buildTriagePrompt } from "../src/engine/forge/inbox/prompt.js";
import { CI_INSIGHTS_CONFIG_MARKER, CI_INSIGHTS_SOURCE_NAME } from "../src/engine/forge/inbox/ciInsightsSource.js";
import type {
  CandidateTriage,
  InboxSource,
  TriageAnswerer,
  TriageRoutableSpec,
} from "../src/engine/forge/inbox/index.js";

const ORG = "org_a";
const PROJECT = "project_a";
const NOW = new Date("2026-05-20T00:00:00Z");

// A triage answerer returning a fixed verdict (the model stand-in — no provider).
function fixedTriage(verdict: CandidateTriage["verdict"], routableSpec: TriageRoutableSpec | null): TriageAnswerer {
  return {
    async triage(): Promise<CandidateTriage> {
      return {
        dedupe: "no match",
        match: "ci root cause",
        placement: "auto",
        verdict,
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
  acceptanceCriteria: ["fixture isolated", "clock injected", "no toggled SHA over the window"],
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

// SQL-substring stub pool. Tracks ci_test_results (read), inbox_sources (find/create),
// candidates (open-dedupe read + upsert + resolve), and the spec INSERT (the DAG ship).
function stubPool(testRows: TestRowSeed[]): {
  pool: pg.Pool;
  sources: Map<string, Record<string, unknown>>;
  candidates: Map<string, Record<string, unknown>>;
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
      // Idempotent: a re-upsert keeps a terminal status, else takes EXCLUDED.status.
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
    // discovery accept → createSpec support
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
  return { pool: pool as unknown as pg.Pool, sources, candidates, specInserts };
}

// A flaky test toggled on `shaCount` distinct SHAs (both pass+fail on each).
function flakyRows(testId: string, suite: string, shaCount: number): TestRowSeed[] {
  const rows: TestRowSeed[] = [];
  for (let i = 0; i < shaCount; i += 1) {
    const sha = `sha${i}`;
    rows.push({
      test_id: testId,
      head_sha: sha,
      outcome: "failed",
      duration_ms: null,
      retries: 0,
      suite,
      observed_at: new Date(NOW.getTime() - 2000),
    });
    rows.push({
      test_id: testId,
      head_sha: sha,
      outcome: "passed",
      duration_ms: null,
      retries: 0,
      suite,
      observed_at: new Date(NOW.getTime() - 1000),
    });
  }
  return rows;
}

function emit(pool: pg.Pool, answerer: TriageAnswerer) {
  return runWithJobOrgId(ORG, () =>
    emitCiInsightCandidates({
      pool,
      projectId: PROJECT,
      orgId: ORG,
      answerer,
      autoRoute: intakeAutoRouteDeps(),
      now: NOW,
    }),
  );
}

describe("flaky CI insight → generative candidate + spec", () => {
  it("a flaky test proven on >= the threshold SHAs auto-routes a ci-flaky candidate and ships a spec", async () => {
    const { pool, sources, candidates, specInserts } = stubPool(flakyRows("suite.flaky", "unit", 2));
    const { candidates: out } = await emit(pool, fixedTriage("auto_routable", fixSpec));

    // One auto-routed candidate keyed `ci-flaky:<test_id>`, namespaced + idempotent.
    expect(out).toHaveLength(1);
    expect(out[0]!.externalId).toBe("ci-flaky:suite.flaky");
    expect(out[0]!.title).toBe("Flaky test: suite.flaky");
    expect(out[0]!.status).toBe("accepted");
    // The CI-insights system source was created (auto-routing, marker-stamped).
    const src = [...sources.values()].find((s) => s.name === CI_INSIGHTS_SOURCE_NAME)!;
    expect(src.kind).toBe("system");
    expect(src.auto_route).toBe("true");
    expect((src.config as Record<string, unknown>)[CI_INSIGHTS_CONFIG_MARKER]).toBe(true);
    // The fix-spec shipped through the SAME accept path.
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.title).toBe(fixSpec.title);
    expect(candidates.size).toBe(1);
  });

  it("anti-spam: a flake below the recurrence threshold generates NO candidate", async () => {
    // One toggled SHA only (< ciInsightFlakyMinShas default 2): quarantined by PR2,
    // but not yet a durable fix-spec.
    const { pool, candidates, specInserts } = stubPool(flakyRows("suite.flaky", "unit", 1));
    const { candidates: out } = await emit(pool, fixedTriage("auto_routable", fixSpec));
    expect(out).toHaveLength(0);
    expect(candidates.size).toBe(0);
    expect(specInserts).toHaveLength(0);
  });

  it("APEX MODE: a single-run flake (< the 2-SHA default) is spec-eligible (the bar drops to 1)", async () => {
    // Loop 4 self-config: an apex / autonomous run has no operator to notice a
    // quarantine awaiting a second-SHA recurrence, so `resolveInsightThresholds()`
    // lowers `ciInsightFlakyMinShas` to 1 — the SAME single-SHA flake the anti-spam
    // test above proves yields NO candidate in normal mode now ships a fix-spec.
    const prior = process.env["TANREN_APEX_MODE"];
    process.env["TANREN_APEX_MODE"] = "1";
    try {
      const { pool, candidates, specInserts } = stubPool(flakyRows("suite.flaky", "unit", 1));
      const { candidates: out } = await emit(pool, fixedTriage("auto_routable", fixSpec));
      expect(out).toHaveLength(1);
      expect(out[0]!.externalId).toBe("ci-flaky:suite.flaky");
      expect(candidates.size).toBe(1);
      expect(specInserts).toHaveLength(1);
    } finally {
      if (prior === undefined) delete process.env["TANREN_APEX_MODE"];
      else process.env["TANREN_APEX_MODE"] = prior;
    }
  });

  it("idempotent: a re-run does not duplicate the candidate or the spec", async () => {
    const { pool, candidates, specInserts } = stubPool(flakyRows("suite.flaky", "unit", 2));
    const answerer = fixedTriage("auto_routable", fixSpec);
    await emit(pool, answerer);
    const { candidates: second } = await emit(pool, answerer);
    // Second pass: the test already has an OPEN (accepted) candidate → skipped.
    expect(second).toHaveLength(0);
    expect(candidates.size).toBe(1);
    expect(specInserts).toHaveLength(1);
  });
});

describe("slow CI insight → generative candidate + spec", () => {
  it("a slow suite (>= 2 slow tests) auto-routes a ci-slow candidate and ships a spec", async () => {
    // Two tests in suite "integration", each with >= minSamples slow durations
    // (p95 over the 30s absolute bar) so both flag slow.
    const rows: TestRowSeed[] = [];
    for (const testId of ["integration.a", "integration.b"]) {
      for (let i = 0; i < 6; i += 1) {
        rows.push({
          test_id: testId,
          head_sha: `sha${i}`,
          outcome: "passed",
          duration_ms: 45_000,
          retries: 0,
          suite: "integration",
          observed_at: new Date(NOW.getTime() - (10 - i) * 1000),
        });
      }
    }
    const { pool, specInserts, candidates } = stubPool(rows);
    const { candidates: out } = await emit(
      pool,
      fixedTriage("auto_routable", { ...fixSpec, title: "Split integration suite" }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.externalId).toBe("ci-slow:integration");
    expect(out[0]!.title).toBe("Slow CI suite: integration");
    expect(out[0]!.status).toBe("accepted");
    expect(specInserts).toHaveLength(1);
    expect(candidates.size).toBe(1);
  });
});

describe("no resolvable fix → needs_call (inbox), not a fabricated spec", () => {
  it("a CI insight whose triage returns needs_call rests in the inbox with no spec", async () => {
    const { pool, candidates, specInserts } = stubPool(flakyRows("suite.flaky", "unit", 2));
    const { candidates: out } = await emit(pool, fixedTriage("needs_call", null));
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("triaged");
    expect(out[0]!.triage?.verdict).toBe("needs_call");
    expect(specInserts).toHaveLength(0);
    expect(candidates.size).toBe(1);
  });
});

describe("root-cause prompt branch", () => {
  const ciSource: InboxSource = {
    id: "src_ci",
    orgId: ORG,
    projectId: PROJECT,
    kind: "system",
    name: CI_INSIGHTS_SOURCE_NAME,
    detail: "",
    config: { [CI_INSIGHTS_CONFIG_MARKER]: true },
    enabled: true,
    autoRoute: true,
  };

  it("renders the CI root-cause branch (evidence + asks WHY) for a CI-insight source", () => {
    const prompt = buildTriagePrompt({
      candidate: {
        title: "Flaky test: suite.flaky",
        body: "Evidence: it BOTH passed AND failed on 2 unchanged commit(s). Sample toggling SHAs: sha0, sha1.",
        severity: "warn",
        sourceKind: "system",
        projectId: PROJECT,
      },
      source: ciSource,
      existingSpecs: [],
    });
    expect(prompt).toContain("CI INSIGHT");
    expect(prompt).toContain("ROOT CAUSE");
    expect(prompt).toContain("race");
    // The evidence body is rendered into the prompt.
    expect(prompt).toContain("Sample toggling SHAs: sha0, sha1");
    // And it forbids fabricating a fix (no-silent-fallback discipline).
    expect(prompt).toContain("Never invent a fix");
  });

  it("does NOT render the CI branch for a non-CI source", () => {
    const prompt = buildTriagePrompt({
      candidate: {
        title: "add analytics",
        body: "count clicks",
        severity: "info",
        sourceKind: "issues",
        projectId: PROJECT,
      },
      source: { ...ciSource, kind: "issues", name: "github", config: {} },
      existingSpecs: [],
    });
    expect(prompt).not.toContain("CI INSIGHT");
  });
});
