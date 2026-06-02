// P2e-1 (autonomy-engine.md §2d "Reaching Mergify parity → removing it
// entirely"): flaky-test detection + auto-quarantine.
//
// Tanren already persists every CI observation as a `ci.passed` / `ci.failed`
// event, each carrying the per-check `checkRuns[]` (name + conclusion) and the
// `headSha` the checks ran against. This module reduces those observations
// across runs/attempts and flags a CHECK that is DEMONSTRABLY non-deterministic.
//
// CRITICAL SAFETY — quarantine ≠ ignore-all-failures:
//   - A check is flaky ONLY when it BOTH passed AND failed on the SAME head SHA
//     (same code, different result) — genuine non-determinism. The toggle must
//     be observed on at least `flakyMinToggledShas` distinct SHAs (default 1, but
//     a higher bar means "repeatedly flaky").
//   - A check that ONLY ever fails (across every SHA) is a CONSISTENT failure —
//     genuinely broken — and is NEVER flagged or quarantined.
//   - A check that ONLY ever passes is fine and is never flagged.
//
// The reducer (`deriveFlakyTests`) is pure over its inputs; the DB loader
// (`loadCiObservations`) is the only impure shell. `detectAndQuarantineFlaky`
// composes them: it computes the flaky verdicts, records each on the
// `quarantined_tests` surface, and emits the operator-visible events
// (`ci.flaky.detected` + `ci.test.quarantined`) so a quarantine is NEVER silent.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { EventStore } from "../eventStore.js";
import { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";
import { type Insight } from "./types.js";

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
 * Load the per-check CI observations for a project + window from the persisted
 * `ci.passed` / `ci.failed` events. Each event carries `checkRuns[]` (name +
 * conclusion) and `headSha`; we flatten to one `CiCheckObservation` per check
 * run. A check run counts as failed when its conclusion is anything other than
 * a clean success.
 */
export async function loadCiObservations(
  pool: Pick<pg.Pool, "query">,
  options: { projectId: string; since: Date },
): Promise<CiCheckObservation[]> {
  const result = await pool.query<CiEventRow>(
    `SELECT payload, ts
       FROM events
       WHERE project_id = $1
         AND event_type IN ('ci.passed','ci.failed')
         AND ts >= $2
       ORDER BY ts ASC`,
    [options.projectId, options.since],
  );
  return flattenCiObservations(result.rows);
}

const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Flatten raw `ci.*` event payloads to per-check observations. Pure. */
export function flattenCiObservations(rows: ReadonlyArray<CiEventRow>): CiCheckObservation[] {
  const out: CiCheckObservation[] = [];
  for (const row of rows) {
    const payload = row.payload as { headSha?: unknown; checkRuns?: unknown };
    const headSha = typeof payload.headSha === "string" ? payload.headSha : undefined;
    if (headSha === undefined) continue;
    const checkRuns = Array.isArray(payload.checkRuns) ? payload.checkRuns : [];
    for (const raw of checkRuns) {
      const check = raw as { name?: unknown; status?: unknown; conclusion?: unknown };
      if (typeof check.name !== "string") continue;
      // Only completed checks carry a verdict; an in-flight (pending) check is
      // not yet an outcome and never contributes to a flaky signal.
      const conclusion = typeof check.conclusion === "string" ? check.conclusion : null;
      if (conclusion === null) continue;
      const outcome: "passed" | "failed" = SUCCESS_CONCLUSIONS.has(conclusion) ? "passed" : "failed";
      out.push({ checkName: check.name, headSha, outcome, observedAt: new Date(row.ts) });
    }
  }
  return out;
}

export interface DetectFlakyContext {
  projectId: string;
  now?: Date;
  thresholds?: Partial<InsightThresholds>;
  eventStore: EventStore;
}

interface ExistingQuarantineRow {
  check_name: string;
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

  const observations = await loadCiObservations(pool, { projectId: context.projectId, since });
  const verdicts = deriveFlakyTests(observations, { minToggledShas: t.flakyMinToggledShas });
  if (verdicts.length === 0) return [];

  const existing = await pool.query<ExistingQuarantineRow>(
    `SELECT check_name FROM quarantined_tests
      WHERE project_id = $1 AND cleared_at IS NULL`,
    [context.projectId],
  );
  const alreadyQuarantined = new Set(existing.rows.map((r) => r.check_name));

  const insights: Insight[] = [];
  for (const verdict of verdicts) {
    const evidence = {
      checkName: verdict.checkName,
      toggledShaCount: verdict.toggledShaCount,
      observationCount: verdict.observationCount,
      passedOnRetryCount: verdict.passedOnRetryCount,
      sampleShas: verdict.sampleShas,
    };

    if (!alreadyQuarantined.has(verdict.checkName)) {
      const quarantineId = `quarantine_${randomUUID()}`;
      // Insert under the partial unique index; ON CONFLICT DO NOTHING makes a
      // concurrent detector pass a no-op rather than an error.
      const inserted = await pool.query(
        `INSERT INTO quarantined_tests
           (id, project_id, check_name, toggled_sha_count, observation_count, evidence, quarantined_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (project_id, check_name) WHERE cleared_at IS NULL DO NOTHING`,
        [
          quarantineId,
          context.projectId,
          verdict.checkName,
          verdict.toggledShaCount,
          verdict.observationCount,
          JSON.stringify(evidence),
          now,
        ],
      );
      // Emit the operator-visible events ONLY on a fresh insert so an operator
      // is notified exactly once per quarantine episode.
      if ((inserted.rowCount ?? 0) > 0) {
        await context.eventStore.append({
          projectId: context.projectId,
          eventType: "ci.flaky.detected",
          payload: evidence,
        });
        await context.eventStore.append({
          projectId: context.projectId,
          eventType: "ci.test.quarantined",
          payload: { ...evidence, quarantineId },
        });
      }
    }

    insights.push(buildFlakyInsight(context.projectId, verdict, now, t.flakyWindowDays));
  }
  return insights;
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
