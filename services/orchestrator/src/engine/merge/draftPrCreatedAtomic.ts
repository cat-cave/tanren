// ATOMIC post-PR-open writes (apex v67/v69 + v86): `github.pr.created` +
// `merge_queue` INSERT + optional `merge.scheduled` on ONE in-transaction client.
//
// Shared by `DirectRunStateWriter`, the control-plane
// `/internal/record-draft-pr-created` endpoint, and the real-PG atomicity test.
// The writer-seam owns the org scope; this applier only rides the supplied client.
//
// PLANE-SPLIT (apex v86): the de-privileged `tanren_dataplane` role has
// REVOKE INSERT on `events` (baseline 0000). The production worker must NEVER
// open `new PgEventStore(dataplaneClient)` for this block — that was the v86
// halt (`permission denied for table events` after a successful GitHub draft PR
// open, leaving the PR as DRAFT forever). Route through `RunStateWriter` so
// Direct uses a privileged pool and Http POSTs to the control plane.

import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import type { RecordDraftPrCreatedInput } from "../contracts/runStateAtomicSeam.js";
import { PgMergeQueueModel } from "./coordinatorPg.js";

/** Anything that can run a parameterized query — pool client checked out under org scope. */
type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Apply the post-PR-open 3-write block on a caller-scoped client. Returns
 * `{ created }` from the merge_queue INSERT (false on partial-unique-index
 * re-publish so the caller / this applier skips a duplicate `merge.scheduled`).
 */
export async function applyRecordDraftPrCreated(
  client: QueryClient,
  input: RecordDraftPrCreatedInput,
): Promise<{ created: boolean }> {
  const events = new PgEventStore(client);
  await events.append({
    runId: input.runId,
    specId: input.specId,
    projectId: input.projectId,
    orgId: input.orgId,
    eventType: "github.pr.created",
    payload: {
      repoUrl: input.repoUrl,
      branch: input.branch,
      targetBranch: input.baseBranch,
      prUrl: input.prUrl,
      prNumber: input.prNumber,
    },
  });
  // `enqueueOnClient` only uses the client argument; the model holds a pool for
  // its own-scope methods (`enqueue` / snapshot) which this applier never calls.
  // A throw-on-touch sentinel keeps accidental pool use loud rather than silent.
  const model = new PgMergeQueueModel(unusedPoolSentinel());
  const { created } = await model.enqueueOnClient(client as pg.PoolClient, input.orgId, {
    projectId: input.projectId,
    runId: input.runId,
    specId: input.specId,
    prUrl: input.prUrl,
    prNumber: input.prNumber,
    targetBranch: input.baseBranch,
  });
  if (created) {
    await events.append({
      runId: input.runId,
      specId: input.specId,
      projectId: input.projectId,
      orgId: input.orgId,
      eventType: "merge.scheduled",
      payload: { prUrl: input.prUrl, prNumber: input.prNumber, integration: "native_queue" },
    });
  }
  return { created };
}

/** Pool never used by this applier — fail loud if a refactor starts calling pool methods. */
function unusedPoolSentinel(): pg.Pool {
  return new Proxy({} as pg.Pool, {
    get() {
      throw new Error("applyRecordDraftPrCreated: pool methods are unused (on-client enqueue only)");
    },
  });
}
