// CI-intelligence PR2: the READ-ONLY quarantine surface. After PR2, the flaky
// DETECTION + quarantine WRITE moved off the dashboard GET onto the worker loop
// (engine/worker/ciInsightsLoop.ts). The GET route must still SHOW every active
// quarantine as a `ci_flaky` insight, but it must NOT trigger a write. This module
// is that read-only surface: it reads the active `quarantined_tests` rows and
// renders one insight each from the persisted evidence — no event emit, no insert.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { type Insight } from "./types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface ActiveQuarantineRow {
  check_name: string;
  test_id: string | null;
  toggled_sha_count: number;
  observation_count: number;
  evidence: unknown;
}

/**
 * Read the project's ACTIVE quarantines and render each as a `ci_flaky` insight
 * (read-only — no detection, no write, no event). Org-scoped under RLS via the
 * caller's client. This is what the dashboard GET calls so an operator keeps
 * seeing every quarantine without the GET being the thing that quarantines.
 */
export async function surfaceActiveQuarantines(client: QueryClient, projectId: string): Promise<Insight[]> {
  const result = await client.query<ActiveQuarantineRow>(
    `SELECT check_name, test_id, toggled_sha_count, observation_count, evidence
       FROM quarantined_tests
      WHERE project_id = $1 AND cleared_at IS NULL
      ORDER BY quarantined_at DESC`,
    [projectId],
  );
  const now = new Date();
  return result.rows.map((row) => buildSurfacedInsight(projectId, row, now));
}

function buildSurfacedInsight(projectId: string, row: ActiveQuarantineRow, now: Date): Insight {
  const isPerTest = row.test_id !== null;
  const target = row.test_id ?? row.check_name;
  const insightId = `insight_ci_flaky_${projectId}_${target}_${randomUUID()}`;
  const grain = isPerTest ? "test" : "check";
  return {
    id: insightId,
    kind: "ci_flaky",
    projectId,
    severity: "warn",
    title: `Flaky ${grain} quarantined: ${target}`,
    body:
      `"${target}" was proven non-deterministic (passed AND failed on ${row.toggled_sha_count} unchanged ` +
      `commit(s)) and is quarantined ${isPerTest ? "per-test (the owning check job stays active)" : ""}` +
      `so its non-determinism does not block the queue. A CONSISTENTLY-failing ${grain} is never ` +
      `quarantined — investigate and clear this once the flake is fixed.`,
    payload: {
      kind: "ci_flaky",
      checkName: row.check_name,
      toggledShaCount: row.toggled_sha_count,
      observationCount: row.observation_count,
      passedOnRetryCount: readPassedOnRetry(row.evidence),
      sampleShas: readSampleShas(row.evidence),
      windowDays: 0,
    },
    actions: [{ label: "Snooze · 24h", toolCall: { tool: "tanren.acknowledge_insight", args: { insightId } } }],
    computedAt: now,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
}

function readPassedOnRetry(evidence: unknown): number {
  if (typeof evidence !== "object" || evidence === null) return 0;
  const bag = evidence as Record<string, unknown>;
  const value = bag["passedOnRetryCount"] ?? bag["intraRunFlakyCount"];
  return typeof value === "number" ? value : 0;
}

function readSampleShas(evidence: unknown): string[] {
  if (typeof evidence !== "object" || evidence === null) return [];
  const value = (evidence as Record<string, unknown>)["sampleShas"];
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
}
