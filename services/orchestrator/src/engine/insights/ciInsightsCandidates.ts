// CI-intelligence PR3 — the GENERATIVE loop's candidate emitter.
//
// PR2 made the worker DETECT + mechanically quarantine flaky/slow CI on a cadence
// (the flake is already non-blocking). PR3 turns that signal into a DURABLE FIX:
// each GENUINE recurring problem becomes one auto-routed inbox candidate whose
// root-cause triage proposes a fix-spec the DagWalker ships — reusing the inbox
// auto-route spine VERBATIM (`InboxStore.upsertCandidate` → `autoRouteCandidate`),
// exactly as `forge/audits/scheduler.ts` emits its findings. There is NO new
// execution path: the candidate funnels through the auto-routing CI-insights
// system source and the same discovery accept the operator click uses.
//
// ANTI-SPAM (escalation discipline) — one candidate per PROBLEM, not per run:
//   (a) idempotent upsert on (source_id, external_id = ci-flaky:<test>/ci-slow:<suite>);
//   (b) a recurrence threshold before generating (flaky proven on >= N distinct SHAs;
//       slow only when the suite carries >= N slow tests — a real suite-split target);
//   (c) skip a test/suite that already has an OPEN candidate (mirror the audit
//       already-routed set) so a re-tick never re-generates a duplicate fix.
// The candidate is created AFTER the mechanical quarantine, so the spec is the
// durable fix, not an emergency. Bounded by the budget gate (the walker enforces it).

import type pg from "pg";
import { orgScopingPool } from "../data/orgScopedDb.js";
import { InboxStore } from "../forge/inbox/store.js";
import { autoRouteCandidate, type AutoRouteDeps } from "../forge/inbox/engine.js";
import {
  CI_INSIGHTS_CONFIG_MARKER,
  CI_INSIGHTS_SOURCE_NAME,
  flakyExternalId,
  slowExternalId,
} from "../forge/inbox/ciInsightsSource.js";
import type { Candidate, InboxSource, TriageAnswerer } from "../forge/inbox/types.js";
import { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";
import { loadCiTestObservations } from "./ciFlaky.js";
import { deriveFlakyTestsPerTest, deriveTestDurationProfiles, type FlakyTestVerdict } from "./ciFlakyTests.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface EmitCiInsightCandidatesDeps {
  /**
   * The real pool. The emitter wraps it in `orgScopingPool` so every tenant
   * read/write self-routes under the per-job org scope the loop establishes
   * (`runWithJobOrgId(orgId)`) — mirroring the intake poller. The DAG insert's
   * `createSpec` re-establishes its own org scope from the auto-route actor, so the
   * spec write is RLS-admitted exactly as the operator/webhook path's.
   */
  pool: pg.Pool;
  projectId: string;
  orgId: string;
  /** The root-cause triage answerer (real provider in prod; a fake in tests). */
  answerer: TriageAnswerer;
  /** The autonomous DAG-insert deps (system actor + plane-split writer). */
  autoRoute: AutoRouteDeps;
  thresholds?: Partial<InsightThresholds>;
  now?: Date;
}

/** A raw CI-insight candidate (the evidence-bearing body the triage reasons over). */
interface CiInsightCandidate {
  externalId: string;
  title: string;
  body: string;
}

export interface EmitCiInsightCandidatesResult {
  candidates: Candidate[];
}

/**
 * Emit one auto-routed candidate per GENUINE recurring CI problem for a project,
 * then root-cause-triage + (when the verdict is a clear mechanical fix) ship the
 * fix-spec into the DAG. Idempotent + recurrence-gated (anti-spam). Returns the
 * candidates created/updated this pass.
 */
export async function emitCiInsightCandidates(
  deps: EmitCiInsightCandidatesDeps,
): Promise<EmitCiInsightCandidatesResult> {
  const t: InsightThresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - t.flakyWindowDays * 24 * 60 * 60 * 1000);
  // Every tenant read/write self-routes under the loop's per-job org scope.
  const pool = orgScopingPool(deps.pool);

  const observations = await loadCiTestObservations(pool, { projectId: deps.projectId, since });
  const flakyVerdicts = deriveFlakyTestsPerTest(observations, { minToggledShas: t.flakyMinToggledShas });
  const durationProfiles = deriveTestDurationProfiles(observations);

  // (b) recurrence threshold: only a REPEATEDLY-flaky test (proven on >= N distinct
  // SHAs) earns a durable fix-spec — a one-off flake is quarantined but not specced.
  const flakyToSpec = flakyVerdicts.filter((v) => v.toggledShaCount >= t.ciInsightFlakyMinShas);
  const slowCandidates = buildSlowSuiteCandidates(durationProfiles, t.ciInsightSlowMinSuiteTests);
  const raw = [...flakyToSpec.map((verdict) => buildFlakyCandidate(verdict)), ...slowCandidates];
  if (raw.length === 0) return { candidates: [] };

  // (c) skip any test/suite that already has an OPEN candidate on this source (mirrors
  // the audit already-routed set) so a re-tick never re-generates a duplicate fix.
  const source = await findOrCreateCiInsightsSource(pool, deps.orgId);
  const open = await openExternalIds(pool, source.id);

  const candidates: Candidate[] = [];
  for (const item of raw) {
    if (open.has(item.externalId)) continue;
    const triage = await deps.answerer.triage({
      candidate: {
        title: item.title,
        body: item.body,
        severity: "warn",
        sourceKind: source.kind,
        projectId: deps.projectId,
      },
      source,
      existingSpecs: [],
    });
    // System source ⇒ an auto_routable verdict rests `auto_routed`; else `triaged`
    // (the candidate waits in the inbox for the product call — NO fabricated fix).
    const status = triage.verdict === "auto_routable" ? "auto_routed" : "triaged";
    let candidate = await InboxStore.upsertCandidate(
      pool,
      source,
      { externalId: item.externalId, title: item.title, body: item.body, severity: "warn", projectId: deps.projectId },
      triage,
      status,
    );
    // Ship the durable fix when (and only when) triage produced a routable spec —
    // the SAME auto-route the operator click + the webhook intake use.
    if (status === "auto_routed" && triage.routableSpec !== null) {
      candidate = (await autoRouteCandidate({ pool }, candidate, triage.routableSpec, deps.autoRoute)).candidate;
    }
    candidates.push(candidate);
  }
  return { candidates };
}

// The flaky candidate's body = the non-determinism evidence (the same the verdict
// computed): the toggled SHAs, the passes-on-retry / intra-run recoveries, and a
// sample of the toggling commits — so the root-cause triage reasons over real data.
function buildFlakyCandidate(verdict: FlakyTestVerdict): CiInsightCandidate {
  const intra = verdict.intraRunFlakyCount > 0 ? ` · recovered intra-run ${verdict.intraRunFlakyCount}×` : "";
  const samples = verdict.sampleShas.length > 0 ? verdict.sampleShas.join(", ") : "(none captured)";
  const body = [
    `Test "${verdict.testId}"${verdict.suite === null ? "" : ` (suite ${verdict.suite})`} is non-deterministic.`,
    `Evidence: it BOTH passed AND failed on ${verdict.toggledShaCount} unchanged commit(s)${intra}`,
    `across ${verdict.observationCount} observation(s).`,
    `Sample toggling SHAs: ${samples}.`,
    "Hypothesize the root cause (race / shared mutable state / test-order dependence /",
    "unmocked external dependency) and propose the mechanical fix.",
  ].join(" ");
  return { externalId: flakyExternalId(verdict.testId), title: `Flaky test: ${verdict.testId}`, body };
}

interface SlowSuite {
  suite: string;
  worst: Array<{ testId: string; p95Ms: number }>;
}

// Group the SLOW duration profiles by suite; a suite is a split candidate only when
// it carries >= `minSuiteTests` slow tests (anti-spam: a lone slow test is a test
// fix, not a suite split). The body carries the p95 trend's worst offenders.
function buildSlowSuiteCandidates(
  profiles: ReadonlyArray<{ testId: string; suite: string | null; p95Ms: number; slow: boolean }>,
  minSuiteTests: number,
): CiInsightCandidate[] {
  const bySuite = new Map<string, SlowSuite>();
  for (const profile of profiles) {
    if (!profile.slow || profile.suite === null) continue;
    const entry = bySuite.get(profile.suite) ?? { suite: profile.suite, worst: [] };
    entry.worst.push({ testId: profile.testId, p95Ms: profile.p95Ms });
    bySuite.set(profile.suite, entry);
  }
  const out: CiInsightCandidate[] = [];
  for (const suite of bySuite.values()) {
    if (suite.worst.length < minSuiteTests) continue;
    const worst = [...suite.worst].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 5);
    const offenders = worst.map((w) => `${w.testId} (p95 ${Math.round(w.p95Ms)}ms)`).join(", ");
    const body = [
      `Suite "${suite.suite}" is slow: ${suite.worst.length} of its tests breach the p95 slow bar.`,
      `The p95 is dominated by: ${offenders}.`,
      "Propose splitting/parallelizing the suite (or the specific worst offenders).",
    ].join(" ");
    out.push({ externalId: slowExternalId(suite.suite), title: `Slow CI suite: ${suite.suite}`, body });
  }
  return out;
}

// Find-or-create the org-wide CI-insights system source (one per org), stamping the
// CI-insight `config` marker so the triage prompt's root-cause branch recognizes it.
// Mirrors `findOrCreateAuditSource` (a `system`-kind source ⇒ no inbox_sources
// kind migration; auto-routes ⇒ candidates promote without a manual click).
async function findOrCreateCiInsightsSource(client: QueryClient, orgId: string): Promise<InboxSource> {
  const existing = (await InboxStore.listSources(client, orgId)).find(
    (s) => s.kind === "system" && s.name === CI_INSIGHTS_SOURCE_NAME,
  );
  if (existing !== undefined) return existing;
  return InboxStore.createSource(client, {
    orgId,
    projectId: null,
    kind: "system",
    name: CI_INSIGHTS_SOURCE_NAME,
    detail: "auto-routes CI root-cause fixes · no manual triage",
    config: { [CI_INSIGHTS_CONFIG_MARKER]: true },
    enabled: true,
    autoRoute: true,
  });
}

// The OPEN external-ids on the CI-insights source (anti-spam dedupe set): a candidate
// is "open" until it reaches a terminal resolution, so a still-pending or already-
// shipped fix is never re-generated on the next tick.
const OPEN_STATUSES = new Set(["new", "triaged", "auto_routed", "accepted"]);

async function openExternalIds(client: QueryClient, sourceId: string): Promise<Set<string>> {
  const result = await client.query<{ external_id: string; status: string }>(
    "SELECT external_id, status FROM candidates WHERE source_id = $1",
    [sourceId],
  );
  return new Set(result.rows.filter((r) => OPEN_STATUSES.has(r.status)).map((r) => r.external_id));
}
