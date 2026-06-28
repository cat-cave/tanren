// task #82 — window-pause auto-resume event schemas. Extracted from the
// parent schema modules (lifecycle / infra) so their 500-line caps hold.
// All three events together model the cycle:
//   run.paused             — the run hit usage-window exhaustion + flipped
//                            to the new non-terminal `paused` status
//   usage.window.refreshed — the prober's capacity-now-available signal
//   run.resumed            — the prober's atomic flip back to `halted`
//                            (which the walker re-drives)
// Every field is a closed-vocab identifier / numeric / ISO timestamp — no
// secret-adjacent content can ride a pause-cycle payload; sensitivity tags
// live in sensitivityRules.windowPause.ts.

import { z } from "zod";

export const RunPausedPayload = z
  .object({
    provider: z.string(),
    slot: z.string(),
    usedPercent: z.number(),
    resetsAt: z.string(),
    reason: z.string(),
  })
  .strict();

export const RunResumedPayload = z
  .object({
    provider: z.string(),
    slot: z.string(),
    usedPercent: z.number(),
    pausedDurationSeconds: z.number(),
  })
  .strict();

export const UsageWindowRefreshedPayload = z
  .object({
    provider: z.string(),
    slot: z.enum(["primary", "secondary", "tertiary"]),
    usedPercent: z.number(),
    refreshSource: z.enum(["post_reset", "early_capacity"]),
    priorUsedPercent: z.number(),
    priorResetsAt: z.string(),
  })
  .strict();

export const windowPauseEventRegistry = {
  "run.paused": RunPausedPayload,
  "run.resumed": RunResumedPayload,
  "usage.window.refreshed": UsageWindowRefreshedPayload,
} as const;
