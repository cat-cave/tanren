// The drive-pass AUTO-REBASE re-gate gate-fail → WRITER REWORK router (the #594 principle
// extended to the merge dispatcher's clean-rebase re-gate path it missed). When the coordinator
// drives a queued run's merge and the post-auto-rebase `pre_merge` gate FAILS a deterministic
// tier on a CLEANLY-rebased branch (no conflict), the code just fails on the new base — route
// the spec to writer rework carrying the gate error as steering (the SAME never-discard re-author
// the resolver / base-shift coordinator use), NEVER a terminal `merge.failed`. Escalation on a
// genuine dead-end is owned by the convergence detector inside the router (a fixed point, no
// count). Extracted as a one-export factory so `coordinatorBuild.ts` wires it with ONE import
// (keeping that file under its dependency cap).

import type pg from "pg";
import type { GateReworkRouter } from "../contracts/conflictResolution.js";
import type { EventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { SpecStatusGateReworkRouter } from "../workflow/reviewMerge/conflictResolver/gateReworkRouter.js";
import {
  buildPriorGateReworkReader,
  buildReplanEnqueuer,
} from "../workflow/reviewMerge/conflictResolver/replanEnqueuerPg.js";

export interface BuildDriveReGateGateReworkDeps {
  pool: pg.Pool;
  /** REQUIRED (audit D-R3.2 sweep): the writer is the single way to write under the de-privileged data plane. */
  runStateWriter: RunStateWriter;
  eventStore: EventStore;
  orgId: string;
  runId: string;
  projectId: string;
  prNumber: number;
}

/** Build the drive-pass re-gate gate-fail rework router (mirrors `conflictResolver/index.ts`). */
export function buildDriveReGateGateRework(deps: BuildDriveReGateGateReworkDeps): GateReworkRouter {
  return new SpecStatusGateReworkRouter({
    pool: deps.pool,
    runStateWriter: deps.runStateWriter,
    orgId: deps.orgId,
    eventStore: deps.eventStore,
    runId: deps.runId,
    projectId: deps.projectId,
    prNumber: deps.prNumber,
    enqueuer: buildReplanEnqueuer(deps.runStateWriter),
    priorReworks: buildPriorGateReworkReader(deps.pool),
  });
}
