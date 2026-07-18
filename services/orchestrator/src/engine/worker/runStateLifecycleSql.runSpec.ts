import type {
  AppendSpecSteeringInput,
  ClearRunPercolationPendingInput,
  MergeRunVerifiedAncestorShaInput,
  SetRunAuthRefInput,
  SetRunPercolationReexecIdInput,
  SetRunPrUrlInput,
  SetRunSpeculativeBaseInput,
  SetRunStatusInput,
  SetSpecMetadataInput,
  SetSpecStatusInput,
} from "../contracts/runStateWriter.js";

/** Anything that can run a parameterized query — the pool or a checked-out client. */
type QueryClient = { query: (text: string, params?: unknown[]) => Promise<{ rowCount?: number | null }> };

/** The non-finalize `UPDATE runs` (the `running` transition). */
export async function applySetRunStatus(client: QueryClient, input: SetRunStatusInput): Promise<void> {
  const statusGuard = " WHERE run_id = $1 AND status = ANY($3::text[])";
  const sql = input.setStartedAt
    ? `UPDATE runs SET status = $2, started_at = now()${statusGuard}`
    : `UPDATE runs SET status = $2${statusGuard}`;
  await client.query(sql, [input.runId, input.status, input.fromStatuses]);
}

/** The `UPDATE runs SET pr_url` after the draft PR is opened. */
export async function applySetRunPrUrl(client: QueryClient, input: SetRunPrUrlInput): Promise<void> {
  await client.query("UPDATE runs SET pr_url = $2 WHERE run_id = $1", [input.runId, input.prUrl]);
}

/**
 * Stamp `runs.auth_ref` (subtask-accounting concurrent-credential dedup). Idempotent —
 * `WHERE auth_ref IS DISTINCT FROM $2` makes a re-stamp of the same value a no-op. The
 * string is byte-identical to the inline `stampRunAuthRef` UPDATE.
 */
export async function applySetRunAuthRef(client: QueryClient, input: SetRunAuthRefInput): Promise<void> {
  await client.query("UPDATE runs SET auth_ref = $2 WHERE run_id = $1 AND auth_ref IS DISTINCT FROM $2", [
    input.runId,
    input.authRef,
  ]);
}

/** The `UPDATE specs SET status` (`in_flight` / merge-outcome). */
export async function applySetSpecStatus(client: QueryClient, input: SetSpecStatusInput): Promise<void> {
  // Optional idempotency guard (the merge coordinator's `merged` finalize + reopen):
  // `WHERE status <> ALL($3)` so a spec already in a terminal-good state is not
  // clobbered. Omitted ⇒ the unguarded set (the workflow's `in_flight`), unchanged.
  if (input.notFromStatuses !== undefined && input.notFromStatuses.length > 0) {
    await client.query("UPDATE specs SET status = $2 WHERE spec_id = $1 AND status <> ALL($3::text[])", [
      input.specId,
      input.status,
      input.notFromStatuses,
    ]);
    return;
  }
  await client.query("UPDATE specs SET status = $2 WHERE spec_id = $1", [input.specId, input.status]);
}

/** The `UPDATE specs SET metadata` (the intake's discovery-provenance stamp). */
export async function applySetSpecMetadata(client: QueryClient, input: SetSpecMetadataInput): Promise<void> {
  await client.query("UPDATE specs SET metadata = $2::jsonb WHERE spec_id = $1", [input.specId, input.metadataJson]);
}

/**
 * Append the steering note to the spec's description (v55 #59 plane-split fix —
 * mirrors the prior raw UPDATE in `RecoveryStore.appendSteeringToSpec`).
 */
export async function applyAppendSpecSteering(client: QueryClient, input: AppendSpecSteeringInput): Promise<void> {
  await client.query(
    `UPDATE specs SET description = description || E'\\n\\n[operator steering] ' || $2 WHERE spec_id = $1`,
    [input.specId, input.steeringNote],
  );
}

// --- Change-percolation (§2c) run-column writes — byte-identical to the inline SQL. ---

/**
 * Re-point a speculative run's dynamic base to the re-resolved ANCESTOR STACK (the
 * never-discard base-shift re-point). jj-local: the base shift writes ONLY
 * `runs.ancestor_stack` — the ordered stack is the sole base truth (jj-local has no
 * synthesized host ref; the legacy `speculative_base` column was dropped in WS-B PR-12).
 */
export async function applySetRunSpeculativeBase(
  client: QueryClient,
  input: SetRunSpeculativeBaseInput,
): Promise<void> {
  await client.query("UPDATE runs SET ancestor_stack = $2::jsonb WHERE run_id = $1", [
    input.runId,
    input.ancestorStack === undefined ? null : JSON.stringify(input.ancestorStack),
  ]);
}

/** Stamp the percolation re-execution run id onto the dependent's in-flight marker. */
export async function applySetRunPercolationReexecId(
  client: QueryClient,
  input: SetRunPercolationReexecIdInput,
): Promise<void> {
  await client.query(
    `UPDATE runs
        SET percolation_pending = COALESCE(percolation_pending, '{}'::jsonb) || jsonb_build_object('reexecRunId', $2::text)
      WHERE run_id = $1`,
    [input.runId, input.reexecRunId],
  );
}

/** Clear the in-flight percolation marker once a percolation settled. */
export async function applyClearRunPercolationPending(
  client: QueryClient,
  input: ClearRunPercolationPendingInput,
): Promise<void> {
  await client.query("UPDATE runs SET percolation_pending = NULL WHERE run_id = $1", [input.runId]);
}

/** Merge ONE ancestor's absorbed SHA + verdict into `verified_ancestor_shas`. */
export async function applyMergeRunVerifiedAncestorSha(
  client: QueryClient,
  input: MergeRunVerifiedAncestorShaInput,
): Promise<void> {
  await client.query(
    `UPDATE runs
        SET verified_ancestor_shas =
          COALESCE(verified_ancestor_shas, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
      WHERE run_id = $1`,
    [input.runId, input.ancestorSpecId, input.entryJson],
  );
}

/** Cancel the vestigial queued `plan` task the spec-run trigger pre-created. */
export async function applySupersedeQueuedPlannerTask(client: QueryClient, runId: string): Promise<void> {
  await client.query(
    "UPDATE tasks SET status = 'cancelled', outcome = 'cancelled', ended_at = now() WHERE run_id = $1 AND kind = 'plan' AND status = 'queued'",
    [runId],
  );
}
