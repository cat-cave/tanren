// Tanren-method benchmark entities — Zod is the single source of truth
// (docs/roadmap/tanren-method-benchmark.md §4.2). These mirror the three new
// tables in db/src/schema.ts: `experiments` / `experiment_cells` /
// `experiment_trials`. The benchmark is a THIN indexing layer over the existing
// run/event/cost data plane — the heavy per-run data stays in runs/cost_records
// /events; an `experiment_trials` row only joins a benchmark observation onto a
// real `runs` row (§4.2).

import { z } from "zod";
import { EscapeHatches, GovernancePosture, MergeIntegration, RoutingTable } from "../config/shared.js";
import { CiTiers, CiWhenPolicy } from "../ci/schema.js";

// ---- Seed task reference --------------------------------------------------

// The pinned seed task (§3.1): the repo + commit SHA + the content-addressed
// hash of the hidden `accept` tier. The accept-tier hash is the equivalence
// oracle's fingerprint — a task whose acceptance changed is a NEW task (§6
// model/oracle-drift), so the hash is part of the task's identity.
export const SeedTaskRef = z
  .object({
    /** The seed repo (e.g. `cat-cave/tanren-fixture-medium`). */
    repo: z.string().min(1),
    /** The pinned commit SHA the trials clone from — the forensic anchor. */
    sha: z.string().min(1),
    /** Content hash of the frozen hidden `accept` tier (§1, §3.3). */
    acceptTierHash: z.string().min(1),
    /** Complexity tier 0/1/2 (§1.1) — stratifies a knob's effect. */
    corpusTier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();
export type SeedTaskRef = z.infer<typeof SeedTaskRef>;

// ---- Frozen cell config ---------------------------------------------------

// The `(RoutingTable × EscapeHatches × tanren-ci tier snapshot × governance)`
// point a cell freezes (§3.1). The whole config lives on the cell row so a
// trial is reproducible from the row alone. Exactly ONE of these dimensions is
// the knob the experiment varies (the §3.3 one-knob invariant, enforced by
// `compareCells`).
export const CiTierSnapshot = z
  .object({
    /** The seed repo's `fast`/`slow` (+ optional `accept`) tier definitions. */
    tiers: CiTiers,
    /** The `when` policy: which tiers run at which workflow phase. */
    when: CiWhenPolicy,
  })
  .strict();
export type CiTierSnapshot = z.infer<typeof CiTierSnapshot>;

export const FrozenConfig = z
  .object({
    routing: RoutingTable,
    escapeHatches: EscapeHatches,
    ciTiers: CiTierSnapshot,
    governance: GovernancePosture,
    mergeIntegration: MergeIntegration,
  })
  .strict();
export type FrozenConfig = z.infer<typeof FrozenConfig>;

// ---- Rows -----------------------------------------------------------------

export const ExperimentRow = z
  .object({
    experimentId: z.string().min(1),
    orgId: z.string().min(1),
    title: z.string().min(1),
    /** The single dimension under test across this experiment's cells. */
    knob: z.string().min(1),
    hypothesis: z.string().min(1),
    seedTaskRef: SeedTaskRef,
    createdAt: z.date(),
  })
  .strict();
export type ExperimentRow = z.infer<typeof ExperimentRow>;

export const ExperimentCellRow = z
  .object({
    cellId: z.string().min(1),
    experimentId: z.string().min(1),
    label: z.string().min(1),
    frozenConfig: FrozenConfig,
    /** Target trial count for this cell (N). Driven by observed variance (§3.2). */
    trialsTarget: z.number().int().min(1),
  })
  .strict();
export type ExperimentCellRow = z.infer<typeof ExperimentCellRow>;

// The post-merge hidden-accept-tier outcome (§2.1). Nullable on the trial: the
// accept step is a follow-up, so a trial can exist before its accept result.
export const AcceptResult = z.enum(["passed", "failed"]);
export type AcceptResult = z.infer<typeof AcceptResult>;

export const ExperimentTrialRow = z
  .object({
    trialId: z.string().min(1),
    cellId: z.string().min(1),
    /** The real run backing this trial — the join into the data plane. */
    runId: z.string().min(1),
    trialIndex: z.number().int().nonnegative(),
    acceptResult: AcceptResult.nullable(),
    /** The cached projected `TrialScorecard` (see scorecard.ts). */
    scorecard: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ExperimentTrialRow = z.infer<typeof ExperimentTrialRow>;
