// P2e-1 CI analytics types (autonomy-engine.md §2d Mergify parity, item 2:
// "CI analytics / insights per project"). The shapes are language-neutral and
// schema-validated so the read route and any future consumer share one
// contract. Pure compute — no write path.

import { z } from "zod";

/** Timing + pass-rate for a single named check across the window. */
export const CiCheckStat = z
  .object({
    checkName: z.string(),
    /** Total observations of this check (completed runs only). */
    observations: z.number().int().nonnegative(),
    /** Observations that concluded successfully. */
    passes: z.number().int().nonnegative(),
    /** Pass-rate in [0,1]; null when there are zero observations. */
    passRate: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type CiCheckStat = z.infer<typeof CiCheckStat>;

/** A timed CI run (a `ci.started` → terminal pair) and its duration. */
export const CiTimingStat = z
  .object({
    /** Median wall-clock seconds from ci.started to its terminal ci.* event. */
    medianSeconds: z.number().nonnegative().nullable(),
    /** Slowest observed CI run duration in seconds. */
    maxSeconds: z.number().nonnegative().nullable(),
    /** How many ci.started→terminal pairs contributed to the timing. */
    sample: z.number().int().nonnegative(),
  })
  .strict();
export type CiTimingStat = z.infer<typeof CiTimingStat>;

export const CiAnalytics = z
  .object({
    projectId: z.string(),
    windowStart: z.string(),
    windowEnd: z.string(),
    windowDays: z.number().int().positive(),
    /** Project-level CI pass-rate: passing terminal CI runs / all terminal runs. */
    runPassRate: z.number().min(0).max(1).nullable(),
    totalCiRuns: z.number().int().nonnegative(),
    passedCiRuns: z.number().int().nonnegative(),
    /** Retry rate: fraction of head SHAs that needed more than one CI run. */
    retryRate: z.number().min(0).max(1).nullable(),
    timing: CiTimingStat,
    /** Per-check pass-rate, sorted least-reliable first. */
    checks: z.array(CiCheckStat),
    /** The slowest steps/checks — those whose individual fail-rate is highest. */
    slowestChecks: z.array(CiCheckStat),
    computedAt: z.string(),
  })
  .strict();
export type CiAnalytics = z.infer<typeof CiAnalytics>;
