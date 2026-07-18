// bh-14b — the pure self-healing funnel aggregation. The Self-Healing dashboard
// surface shows how the org's issue loops progress through the autonomous
// reproduce → fix → merge → deploy → symptom-verify → source-close pipeline.
//
// The funnel is computed from TWO real, org-scoped read surfaces: the mutable
// `issue_loops.state` (covers every in-flight loop) and, for terminal loops, the
// sealed `resolution_proofs` truth badges (bh-14a). A loop's furthest stage is the
// max of its state-implied stage and its badge-implied stage — so a COSMETIC fix
// that merged + deployed (badges green) but whose symptom verification FAILED never
// reaches `symptom_verified`: the funnel drop-off IS the false-green catch.
//
// Pure + deterministic: the route reads the rows and calls `computeSelfHealingFunnel`,
// and a unit test drives the exact aggregation without a DB.

import type { IssueLoopState } from "../repositories/issueLoops.js";

/** The seven funnel stages, in progression order (index 0 = earliest). */
export const SELF_HEALING_STAGES = [
  "opened",
  "reproduced",
  "fixed",
  "merged",
  "deployed",
  "symptom_verified",
  "source_closed",
] as const;
export type SelfHealingStage = (typeof SELF_HEALING_STAGES)[number];

/**
 * The six SEPARATE truth badges bh-14a seals — never collapsed into one green.
 * Mirrors `ResolutionProofBadges`; duplicated here so the funnel reads the stored
 * `proof_json.badges` without depending on the sealer's collection module.
 */
export interface SelfHealingBadges {
  readonly gate: string;
  readonly merged: string;
  readonly deploy: string;
  readonly demo: string;
  readonly symptom: string;
  readonly source: string;
}

/** One issue loop plus its latest sealed-proof badges (null when never sealed). */
export interface SelfHealingLoopInput {
  readonly loopId: string;
  readonly projectId: string;
  readonly state: IssueLoopState;
  readonly severity: string;
  readonly fingerprint: string;
  readonly terminal: string | null;
  readonly badges: SelfHealingBadges | null;
}

/** A loop projected onto the funnel: its furthest reached stage + badge truth. */
export interface SelfHealingLoopSummary {
  readonly loopId: string;
  readonly projectId: string;
  readonly state: IssueLoopState;
  readonly severity: string;
  readonly fingerprint: string;
  readonly furthestStage: SelfHealingStage;
  readonly hasProof: boolean;
  readonly terminal: string | null;
  readonly badges: SelfHealingBadges | null;
}

export type SelfHealingFunnelCounts = Readonly<Record<SelfHealingStage, number>>;

export interface SelfHealingFunnel {
  readonly counts: SelfHealingFunnelCounts;
  readonly loops: readonly SelfHealingLoopSummary[];
  readonly totalLoops: number;
}

// The mutable loop state's furthest funnel stage. A later state implies every
// earlier stage (cumulative), so a single index per state is enough. `verifying`
// implies merge + deploy already happened (production verification binds a
// deployed artifact). Terminal-but-unverified states (`needs_attention`,
// `externally_closed_unverified`) rank at `fixed`; the sealed badges refine them
// upward only when a specific badge is actually positive.
const STATE_STAGE_INDEX: Readonly<Record<IssueLoopState, number>> = {
  open: 0,
  awaiting_reproduction: 0,
  reproduced: 1,
  triaged: 1,
  remediating: 2,
  verifying: 4,
  verified_source_sync_pending: 5,
  verified_closed: 6,
  externally_closed_unverified: 2,
  needs_attention: 2,
  wont_fix: 0,
};

/**
 * The badge-implied furthest stage. Each badge only ever ADDS a reached stage
 * when it is positive — a FAILED symptom never yields `symptom_verified`, so a
 * cosmetic fix cannot false-green its way past the symptom stage.
 */
function badgeStageIndex(badges: SelfHealingBadges | null): number {
  if (badges === null) return -1;
  let index = -1;
  if (badges.merged === "passed") index = Math.max(index, 3);
  if (badges.deploy === "bound") index = Math.max(index, 4);
  if (badges.symptom === "passed") index = Math.max(index, 5);
  if (badges.source === "verified_closed") index = Math.max(index, 6);
  return index;
}

function furthestStageIndex(loop: SelfHealingLoopInput): number {
  return Math.max(STATE_STAGE_INDEX[loop.state], badgeStageIndex(loop.badges));
}

function emptyCounts(): Record<SelfHealingStage, number> {
  const counts = {} as Record<SelfHealingStage, number>;
  for (const stage of SELF_HEALING_STAGES) counts[stage] = 0;
  return counts;
}

/**
 * Aggregate the org's issue loops into the cumulative funnel. A loop increments
 * every stage from `opened` through its furthest reached stage, so each count is
 * "loops that reached at least this stage" — the classic monotone funnel shape.
 */
export function computeSelfHealingFunnel(loops: readonly SelfHealingLoopInput[]): SelfHealingFunnel {
  const counts = emptyCounts();
  const summaries: SelfHealingLoopSummary[] = [];
  for (const loop of loops) {
    const index = furthestStageIndex(loop);
    for (let stage = 0; stage <= index; stage += 1) {
      const key = SELF_HEALING_STAGES[stage];
      if (key !== undefined) counts[key] += 1;
    }
    summaries.push({
      loopId: loop.loopId,
      projectId: loop.projectId,
      state: loop.state,
      severity: loop.severity,
      fingerprint: loop.fingerprint,
      furthestStage: SELF_HEALING_STAGES[index] ?? "opened",
      hasProof: loop.badges !== null,
      terminal: loop.terminal,
      badges: loop.badges,
    });
  }
  return { counts, loops: summaries, totalLoops: loops.length };
}
