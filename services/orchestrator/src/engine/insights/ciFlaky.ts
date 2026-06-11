// Flaky-test detection + auto-quarantine (autonomy-engine.md §2d), the native
// CI intelligence that makes a managed merge queue unnecessary.
//
// Tanren persists every native gate run as a `gate.verdict` event, each carrying
// the per-step `steps[]` (name + passed) and the `headSha` the gate ran against.
// This module reduces those verdicts across runs/attempts and flags a STEP that is
// DEMONSTRABLY non-deterministic. (A "check" here is a native gate STEP — the
// native delivery model's grain — not a forge check-run.)
//
// CRITICAL SAFETY — quarantine ≠ ignore-all-failures:
//   - A step is flaky ONLY when it BOTH passed AND failed on the SAME head SHA
//     (same code, different result) — genuine non-determinism. The toggle must
//     be observed on at least `flakyMinToggledShas` distinct SHAs (default 1, but
//     a higher bar means "repeatedly flaky").
//   - A step that ONLY ever fails (across every SHA) is a CONSISTENT failure —
//     genuinely broken — and is NEVER flagged or quarantined.
//   - A step that ONLY ever passes is fine and is never flagged.
//
// The reducer (`deriveFlakyTests`) is pure over its inputs; the DB loader
// (`loadCiObservations`) is the only impure shell. `detectAndQuarantineFlaky`
// composes them: it computes the flaky verdicts, records each on the
// `quarantined_tests` surface, and emits the operator-visible events
// (`ci.flaky.detected` + `ci.test.quarantined`) so a quarantine is NEVER silent.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { EventStore } from "../eventStore.js";
import type { EventPayload } from "../events/index.js";
import { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";
import { type Insight } from "./types.js";
import { type CiTestObservation, deriveFlakyTestsPerTest, type FlakyTestVerdict } from "./ciFlakyTests.js";

/** A single per-check CI outcome observed on one head SHA at one instant. */
export interface CiCheckObservation {
  checkName: string;
  headSha: string;
  /** Normalized outcome: did this check pass or fail on this observation? */
  outcome: "passed" | "failed";
  /** The observation order anchor (the CI event `ts`), for passes-on-retry. */
  observedAt: Date;
}

/** The non-determinism verdict for a single flaky check. */
export interface FlakyVerdict {
  checkName: string;
  /** Distinct head SHAs on which the check BOTH passed and failed (≥ 1). */
  toggledShaCount: number;
  /** Total observations of this check (pass + fail) across the window. */
  observationCount: number;
  /** Times the check failed then later passed on the SAME head SHA. */
  passedOnRetryCount: number;
  /** A capped sample of the toggling SHAs, for operator triage. */
  sampleShas: string[];
}

const MAX_SAMPLE_SHAS = 5;

// Generous hard row cap on the time-bounded CI observation scans (gate.verdict
// events + ci_test_results). The window already bounds the lookback; this caps a
// pathological flood inside the window so the read can never be unbounded. Rows
// are ordered newest-first, so the cap retains the most recent (most relevant)
// observations; the reducers re-sort, so the verdict is order-independent.
const CI_OBSERVATION_SCAN_LIMIT = 10_000;

/**
 * Pure flaky reducer. Groups observations by check name, then — per check — by
 * head SHA. A check is flaky iff it both passed AND failed on the same SHA on at
 * least `minToggledShas` distinct SHAs. A check that only ever fails (or only
 * ever passes) on every SHA yields NO verdict. Deterministic over its inputs.
 */
export function deriveFlakyTests(
  observations: ReadonlyArray<CiCheckObservation>,
  options: { minToggledShas?: number } = {},
): FlakyVerdict[] {
  const minToggledShas = options.minToggledShas ?? 1;

  // checkName → (headSha → outcomes-in-observed-order)
  const byCheck = new Map<string, Map<string, Array<{ outcome: "passed" | "failed"; observedAt: Date }>>>();
  for (const obs of observations) {
    let bySha = byCheck.get(obs.checkName);
    if (bySha === undefined) {
      bySha = new Map();
      byCheck.set(obs.checkName, bySha);
    }
    const list = bySha.get(obs.headSha) ?? [];
    list.push({ outcome: obs.outcome, observedAt: obs.observedAt });
    bySha.set(obs.headSha, list);
  }

  const verdicts: FlakyVerdict[] = [];
  for (const [checkName, bySha] of byCheck) {
    let toggledShaCount = 0;
    let observationCount = 0;
    let passedOnRetryCount = 0;
    const sampleShas: string[] = [];

    for (const [headSha, outcomes] of bySha) {
      observationCount += outcomes.length;
      const passed = outcomes.some((o) => o.outcome === "passed");
      const failed = outcomes.some((o) => o.outcome === "failed");
      // A toggle on ONE sha = both a pass and a fail on UNCHANGED code.
      if (passed && failed) {
        toggledShaCount += 1;
        if (sampleShas.length < MAX_SAMPLE_SHAS) sampleShas.push(headSha);
        // Passes-on-retry: a fail strictly BEFORE a later pass on this SHA.
        const ordered = [...outcomes].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
        const firstFail = ordered.findIndex((o) => o.outcome === "failed");
        const laterPass = ordered.findIndex((o, i) => i > firstFail && o.outcome === "passed");
        if (firstFail !== -1 && laterPass !== -1) passedOnRetryCount += 1;
      }
    }

    // SAFETY GATE: only a check with a genuine toggle (≥ minToggledShas distinct
    // SHAs showing both outcomes) is flaky. A consistently-failing check has
    // toggledShaCount === 0 here and is therefore NEVER returned.
    if (toggledShaCount >= minToggledShas) {
      verdicts.push({ checkName, toggledShaCount, observationCount, passedOnRetryCount, sampleShas });
    }
  }

  // Stable order: most-toggled first, then by name for determinism.
  verdicts.sort((a, b) => b.toggledShaCount - a.toggledShaCount || a.checkName.localeCompare(b.checkName));
  return verdicts;
}

interface CiEventRow {
  payload: unknown;
  ts: Date;
}

/**
 * Load the per-step gate observations for a project + window from the persisted
 * `gate.verdict` events. Each verdict carries `steps[]` (name + passed) and
 * `headSha`; we flatten to one `CiCheckObservation` per step. A step counts as
 * failed when its `passed` flag is not strictly true.
 */
export async function loadCiObservations(
  pool: Pick<pg.Pool, "query">,
  options: { projectId: string; since: Date },
): Promise<CiCheckObservation[]> {
  const result = await pool.query<CiEventRow>(
    // Time-bounded by `since`, PLUS a hard row LIMIT: a pathological project that
    // floods gate.verdict events inside the window must not return an unbounded
    // result set. Ordered DESC so the cap keeps the MOST RECENT verdicts (the ones
    // that matter for current flakiness); the pure reducer re-sorts by observed
    // time, so DESC-vs-ASC does not change the verdict.
    `SELECT payload, ts
       FROM events
       WHERE project_id = $1
         AND event_type = 'gate.verdict'
         AND ts >= $2
       ORDER BY ts DESC
       LIMIT ${CI_OBSERVATION_SCAN_LIMIT}`,
    [options.projectId, options.since],
  );
  return flattenCiObservations(result.rows);
}

/** Flatten raw `gate.verdict` event payloads to per-step observations. Pure. */
export function flattenCiObservations(rows: ReadonlyArray<CiEventRow>): CiCheckObservation[] {
  const out: CiCheckObservation[] = [];
  for (const row of rows) {
    const payload = row.payload as { headSha?: unknown; steps?: unknown };
    const headSha = typeof payload.headSha === "string" ? payload.headSha : undefined;
    if (headSha === undefined) continue;
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    for (const raw of steps) {
      const step = raw as { name?: unknown; passed?: unknown };
      if (typeof step.name !== "string") continue;
      const outcome: "passed" | "failed" = step.passed === true ? "passed" : "failed";
      out.push({ checkName: step.name, headSha, outcome, observedAt: new Date(row.ts) });
    }
  }
  return out;
}

interface CiTestRow {
  test_id: string;
  file: string | null;
  suite: string | null;
  head_sha: string;
  outcome: string;
  duration_ms: number | null;
  retries: number;
  observed_at: Date | string;
}

/**
 * Load the per-test results for a project + window from `ci_test_results` (the
 * JUnit-ingested per-test history). Each row is one `<testcase>` for one (run,
 * attempt). Org-scoped under RLS by the caller's client — a read off the wrong
 * scope sees zero rows. Pure DB shell; the reducers in `ciFlakyTests.ts` derive
 * the verdicts.
 */
export async function loadCiTestObservations(
  pool: Pick<pg.Pool, "query">,
  options: { projectId: string; since: Date },
): Promise<CiTestObservation[]> {
  const result = await pool.query<CiTestRow>(
    // Time-bounded by `since`, PLUS a hard row LIMIT. A large suite over a long
    // window can emit very many per-test rows; the cap keeps the read O(LIMIT).
    // Ordered DESC so truncation keeps the MOST RECENT results; the pure reducer
    // re-sorts by observed time, so the verdict is unchanged by the order here.
    `SELECT test_id, file, suite, head_sha, outcome, duration_ms, retries, observed_at
       FROM ci_test_results
      WHERE project_id = $1
        AND observed_at >= $2
      ORDER BY observed_at DESC
      LIMIT ${CI_OBSERVATION_SCAN_LIMIT}`,
    [options.projectId, options.since],
  );
  return result.rows.map((row) => ({
    testId: row.test_id,
    file: row.file,
    suite: row.suite,
    headSha: row.head_sha,
    outcome: normalizeTestOutcome(row.outcome),
    durationMs: row.duration_ms,
    retries: row.retries,
    observedAt: row.observed_at instanceof Date ? row.observed_at : new Date(row.observed_at),
  }));
}

function normalizeTestOutcome(raw: string): CiTestObservation["outcome"] {
  return raw === "passed" || raw === "failed" || raw === "error" || raw === "skipped" ? raw : "failed";
}

export interface DetectFlakyContext {
  projectId: string;
  now?: Date;
  thresholds?: Partial<InsightThresholds>;
  eventStore: EventStore;
  /**
   * Loads the `ci.*` check observations for `[since, now]`. The events read is a
   * caller-provided seam BECAUSE the two callers sit on different DB planes: the
   * dashboard route runs as `tanren_app`, while the worker loop runs as
   * `tanren_dataplane`. Keeping the read here as an injected loader lets each caller
   * choose the right org/system scope for its plane. `pool` is used only for the tenant tables
   * (`ci_test_results` + `quarantined_tests`), which both planes can reach.
   */
  loadChecks: (since: Date) => Promise<CiCheckObservation[]>;
}

interface ExistingQuarantineRow {
  check_name: string;
  test_id: string | null;
}

/**
 * Detect flaky checks for a project, record each new one on the quarantine
 * surface, and emit the operator-visible events. Returns one `ci_flaky` insight
 * per ACTIVE quarantine so the existing insights surface lists them.
 *
 * Idempotent: a check already actively quarantined is not re-inserted and does
 * not re-emit `ci.test.quarantined` (the partial unique index also guards this),
 * but it is still surfaced as an insight so the operator keeps seeing it.
 */
export async function detectAndQuarantineFlaky(
  pool: Pick<pg.Pool, "query">,
  context: DetectFlakyContext,
): Promise<Insight[]> {
  const t: InsightThresholds = { ...DEFAULT_THRESHOLDS, ...context.thresholds };
  const now = context.now ?? new Date();
  const since = new Date(now.getTime() - t.flakyWindowDays * 24 * 60 * 60 * 1000);

  // Check-level verdicts from the `ci.*` event history (the original grain) AND
  // per-test verdicts from the `ci_test_results` history (the new PR2 grain). Both
  // record onto the SAME quarantine surface and surface as `ci_flaky` insights.
  const checkObservations = await context.loadChecks(since);
  const checkVerdicts = deriveFlakyTests(checkObservations, { minToggledShas: t.flakyMinToggledShas });
  const testObservations = await loadCiTestObservations(pool, { projectId: context.projectId, since });
  const testVerdicts = deriveFlakyTestsPerTest(testObservations, { minToggledShas: t.flakyMinToggledShas });
  if (checkVerdicts.length === 0 && testVerdicts.length === 0) return [];

  // The set of ACTIVE quarantine targets, keyed exactly as the unique index:
  // coalesce(test_id, check_name). Idempotency check before the guarded insert.
  const existing = await pool.query<ExistingQuarantineRow>(
    `SELECT check_name, test_id FROM quarantined_tests
      WHERE project_id = $1 AND cleared_at IS NULL`,
    [context.projectId],
  );
  const activeTargets = new Set(existing.rows.map((r) => r.test_id ?? r.check_name));

  const insights: Insight[] = [];
  for (const verdict of checkVerdicts) {
    const evidence = {
      checkName: verdict.checkName,
      toggledShaCount: verdict.toggledShaCount,
      observationCount: verdict.observationCount,
      passedOnRetryCount: verdict.passedOnRetryCount,
      sampleShas: verdict.sampleShas,
    };
    await recordQuarantine(pool, context, {
      target: verdict.checkName,
      checkName: verdict.checkName,
      testId: null,
      toggledShaCount: verdict.toggledShaCount,
      observationCount: verdict.observationCount,
      evidence,
      now,
      activeTargets,
    });
    insights.push(buildFlakyInsight(context.projectId, verdict, now, t.flakyWindowDays));
  }

  for (const verdict of testVerdicts) {
    // The check_name a per-test quarantine carries is the test's suite when known
    // (so the operator sees the owning job); the test_id is the actuating key.
    const checkName = verdict.suite ?? verdict.testId;
    const evidence = {
      checkName,
      testId: verdict.testId,
      file: verdict.file,
      suite: verdict.suite,
      toggledShaCount: verdict.toggledShaCount,
      observationCount: verdict.observationCount,
      intraRunFlakyCount: verdict.intraRunFlakyCount,
      sampleShas: verdict.sampleShas,
    };
    await recordQuarantine(pool, context, {
      target: verdict.testId,
      checkName,
      testId: verdict.testId,
      toggledShaCount: verdict.toggledShaCount,
      observationCount: verdict.observationCount,
      evidence,
      now,
      activeTargets,
    });
    insights.push(buildFlakyTestInsight(context.projectId, verdict, now, t.flakyWindowDays));
  }
  return insights;
}

interface RecordQuarantineInput {
  /** The coalesce(test_id, check_name) key used for idempotency + the unique index. */
  target: string;
  checkName: string;
  testId: string | null;
  toggledShaCount: number;
  observationCount: number;
  evidence: EventPayload<"ci.flaky.detected">;
  now: Date;
  activeTargets: Set<string>;
}

/**
 * Record ONE quarantine (check-level or per-test) on the surface, idempotently.
 * The partial unique index keyed on coalesce(test_id, check_name) is the hard
 * guard; ON CONFLICT DO NOTHING makes a concurrent detector pass a no-op. The
 * operator-visible events fire ONLY on a fresh insert (exactly once per episode).
 */
async function recordQuarantine(
  pool: Pick<pg.Pool, "query">,
  context: DetectFlakyContext,
  input: RecordQuarantineInput,
): Promise<void> {
  if (input.activeTargets.has(input.target)) return;
  const quarantineId = `quarantine_${randomUUID()}`;
  const inserted = await pool.query(
    `INSERT INTO quarantined_tests
       (id, project_id, check_name, test_id, toggled_sha_count, observation_count, evidence, quarantined_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (project_id, coalesce(test_id, check_name)) WHERE cleared_at IS NULL DO NOTHING`,
    [
      quarantineId,
      context.projectId,
      input.checkName,
      input.testId,
      input.toggledShaCount,
      input.observationCount,
      JSON.stringify(input.evidence),
      input.now,
    ],
  );
  if ((inserted.rowCount ?? 0) > 0) {
    input.activeTargets.add(input.target);
    await context.eventStore.append({
      projectId: context.projectId,
      eventType: "ci.flaky.detected",
      payload: input.evidence,
    });
    await context.eventStore.append({
      projectId: context.projectId,
      eventType: "ci.test.quarantined",
      payload: { ...input.evidence, quarantineId },
    });
  }
}

function buildFlakyTestInsight(projectId: string, verdict: FlakyTestVerdict, now: Date, windowDays: number): Insight {
  const insightId = `insight_ci_flaky_${projectId}_${verdict.testId}_${randomUUID()}`;
  const intraNote = verdict.intraRunFlakyCount > 0 ? ` (recovered intra-run ${verdict.intraRunFlakyCount}×)` : "";
  return {
    id: insightId,
    kind: "ci_flaky",
    projectId,
    severity: "warn",
    title: `Flaky test quarantined: ${verdict.testId}`,
    body:
      `Test "${verdict.testId}" both passed AND failed on ${verdict.toggledShaCount} unchanged ` +
      `commit(s) in the last ${windowDays}d${intraNote}. It is quarantined PER-TEST (the owning ` +
      `check job stays active) so its non-determinism does not block the queue. A CONSISTENTLY-` +
      `failing test is never quarantined — investigate and clear this once the flake is fixed.`,
    payload: {
      kind: "ci_flaky",
      checkName: verdict.suite ?? verdict.testId,
      toggledShaCount: verdict.toggledShaCount,
      observationCount: verdict.observationCount,
      passedOnRetryCount: verdict.intraRunFlakyCount,
      sampleShas: verdict.sampleShas,
      windowDays,
    },
    actions: [
      {
        label: "Snooze · 24h",
        toolCall: { tool: "tanren.acknowledge_insight", args: { insightId } },
      },
    ],
    computedAt: now,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
}

function buildFlakyInsight(projectId: string, verdict: FlakyVerdict, now: Date, windowDays: number): Insight {
  const insightId = `insight_ci_flaky_${projectId}_${verdict.checkName}_${randomUUID()}`;
  const retryNote = verdict.passedOnRetryCount > 0 ? ` (passed-on-retry ${verdict.passedOnRetryCount}×)` : "";
  return {
    id: insightId,
    kind: "ci_flaky",
    projectId,
    severity: "warn",
    title: `Flaky check quarantined: ${verdict.checkName}`,
    body:
      `"${verdict.checkName}" both passed AND failed on ${verdict.toggledShaCount} unchanged ` +
      `commit(s) in the last ${windowDays}d${retryNote}. It is quarantined (recorded + surfaced) ` +
      `so its non-determinism does not block the queue. A CONSISTENTLY-failing check is never ` +
      `quarantined — investigate and clear this once the flake is fixed.`,
    payload: {
      kind: "ci_flaky",
      checkName: verdict.checkName,
      toggledShaCount: verdict.toggledShaCount,
      observationCount: verdict.observationCount,
      passedOnRetryCount: verdict.passedOnRetryCount,
      sampleShas: verdict.sampleShas,
      windowDays,
    },
    actions: [
      {
        label: "Snooze · 24h",
        toolCall: { tool: "tanren.acknowledge_insight", args: { insightId } },
      },
    ],
    computedAt: now,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
}
