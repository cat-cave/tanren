// The LIVE writer-backed `LandFinalizer` (tanren-owns-the-engine.md §5) — the
// DURABLE half of the guaranteed transactional land. `MergeAuthority.land` runs:
// authorize → external land via `CodeHost.landAuthorizedRef` → THIS finalize. The
// finalize records the completed land in ONE org-scoped transaction (`merge.completed`
// + the spec `merged` flip together), so the internal state can never silently
// disagree with the host. A THROW here — after the external land already advanced
// `main` — is exactly the `merge_state_unknown` reconcile signal the authority maps;
// it is NEVER swallowed into a silent inconsistency.
//
// This DELETES the §5-P0 ordering bug (the external merge fired BEFORE the durable
// `merge.completed`/finalize): the host land is now the FIRST step inside `land`, and
// this durable record is the LAST — and a finalize failure after the land is a typed
// reconcile state, not a plain failure.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { PgEventStore } from "../eventStore.js";
import { applySetSpecStatus } from "../worker/runStateLifecycleSql.js";
import type { AuditEnvelope } from "../events/schemas/audit.js";
import type { FinalizeLandInput, RunStateWriter } from "../contracts/runStateWriter.js";
import type { LandAuthorization } from "../contracts/mergeAuthority.js";
import type { AuthorityLandStore } from "./mergeAuthorityV2Impl.js";

/** Anything that can run a parameterized query — the pool or a checked-out client. */
type LandQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * The DURABLE land transaction (tanren-owns-the-engine.md §5), the ONE source of truth
 * shared by the in-process `DirectRunStateWriter`, the control-plane
 * `/internal/finalize-land` endpoint, and the live `buildLandFinalizer` thunk: append
 * `merge.completed` + flip the spec to `merged` (guarded, idempotent) on a SINGLE
 * in-transaction client, so both carry org context and a reconcile retry is a no-op.
 * The caller owns the org scope (`runWithOrgScope`).
 */
export async function applyFinalizeLand(client: LandQueryClient, input: FinalizeLandInput): Promise<void> {
  const events = new PgEventStore(client);
  await events.append({
    runId: input.runId,
    specId: input.specId,
    projectId: input.projectId,
    orgId: input.orgId,
    taskId: input.taskId,
    eventType: "merge.completed",
    payload: {
      prUrl: input.prUrl,
      prNumber: input.prNumber,
      integration: input.integration,
      mergeSha: input.mergeSha,
      ...input.auditEnvelope,
    },
  });
  // The ancestor reaches `merged` HERE, atomically with `merge.completed` — the single
  // point its dependents' merge-hold clears. Guarded so a spec already `merged`/`done`
  // is left alone (idempotent on a reconcile retry).
  await applySetSpecStatus(client, {
    specId: input.specId,
    orgId: input.orgId,
    status: "merged",
    notFromStatuses: ["merged"],
  });
}

/**
 * The durable identity + audit context one land finalize records. Resolved from the
 * run's merge-stage context BEFORE the land (so the finalize never has to re-read it
 * after the external land already fired). `integration` labels the event
 * (`direct_merge` / `native_queue`); `auditEnvelope` carries the policy version +
 * the initiating/approving actors stamped onto `merge.completed`.
 */
export interface LandFinalizeContext {
  orgId: string;
  runId: string;
  specId: string;
  projectId: string;
  taskId: string;
  prUrl: string;
  prNumber: number;
  integration: "direct_merge" | "native_queue";
  auditEnvelope: AuditEnvelope;
}

/** Project the land context + the resolved main sha onto the writer's `finalizeLand` op. */
function finalizeLandInputFrom(context: LandFinalizeContext, mainSha: string): FinalizeLandInput {
  return {
    orgId: context.orgId,
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId: context.taskId,
    prUrl: context.prUrl,
    prNumber: context.prNumber,
    integration: context.integration,
    mergeSha: mainSha,
    auditEnvelope: context.auditEnvelope,
  };
}

/** Insert the authority_decisions + idempotent authority_effect_intents rows (step 1). */
async function persistDecisionRows(
  pool: pg.Pool,
  context: LandFinalizeContext,
  auth: LandAuthorization,
  effectIntentId: string,
): Promise<void> {
  const e = auth.envelope;
  const decisionId = `decision-${auth.subject.id}-${e.headSha}`;
  await runWithOrgScope(pool, context.orgId, async (client) => {
    await client.query(
      `INSERT INTO authority_decisions
         (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
          artifact_digest, proof_root, member_set_hash, policy_version, decision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (org_id, id) DO NOTHING`,
      [
        context.orgId,
        context.projectId,
        decisionId,
        auth.subject.id,
        auth.subject.kind,
        e.headSha,
        e.expectedMainSha,
        e.artifactDigest,
        e.proofRoot,
        e.memberSetHash,
        e.policyVersion,
        auth.decision,
      ],
    );
    await client.query(
      `INSERT INTO authority_effect_intents
         (org_id, project_id, id, decision_id, integration_node_id, into_main, authorized_sha,
          expected_main_sha, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (org_id, idempotency_key) DO NOTHING`,
      [
        context.orgId,
        context.projectId,
        effectIntentId,
        decisionId,
        auth.subject.id,
        e.target.intoMain,
        e.headSha,
        e.expectedMainSha,
        effectIntentId,
      ],
    );
  });
}

/** Insert the authority_land_receipts row (step 3, alongside the run/spec finalize). */
async function persistReceiptRow(
  pool: pg.Pool,
  context: LandFinalizeContext,
  effectIntentId: string,
  mainSha: string,
  auditId: string,
): Promise<void> {
  await runWithOrgScope(pool, context.orgId, async (client) => {
    await client.query(
      `INSERT INTO authority_land_receipts (org_id, project_id, id, effect_intent_id, main_sha, audit_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, effect_intent_id) DO NOTHING`,
      [context.orgId, context.projectId, `receipt-${effectIntentId}`, effectIntentId, mainSha, auditId],
    );
  });
}

/**
 * Build the LIVE {@link AuthorityLandStore} bound to one run's merge-stage context — the
 * durable half of `MergeAuthorityV2`'s 4-step land protocol.
 *
 * STEP 1 (`persistAuthorizedDecision`): persist the immutable `authority_decisions` row +
 * the idempotent `authority_effect_intents` row on the worker pool (org-scoped), returning
 * the deterministic effect-intent id used as the CAS `idempotencyKey`.
 *
 * STEP 3 (`recordLandReceipt`): the GOVERNING `merge.completed` + guarded spec `merged`
 * flip runs through the writer's `finalizeLand` in ONE org-scoped transaction (the §5
 * plane-split record — control plane when remote-writes on, byte-identical
 * `applyFinalizeLand` in-process otherwise), returning the durable `auditId`; the
 * `authority_land_receipts` row is then recorded. A DB failure THROWS, which
 * `MergeAuthorityV2.land` turns into `merge_state_unknown` (the host already advanced
 * `main`) — never a silent inconsistency, never a duplicate land.
 *
 * The merge TASK finalize (task → done + `task.completed`) stays in the dispatcher's
 * existing `finalize("merged")` path on the authorized branch.
 */
export function buildAuthorityLandStore(
  pool: pg.Pool,
  context: LandFinalizeContext,
  writer: RunStateWriter,
): AuthorityLandStore {
  return {
    async persistAuthorizedDecision(input: { authorization: LandAuthorization }): Promise<{ effectIntentId: string }> {
      const effectIntentId = `intent-${input.authorization.subject.id}-${input.authorization.envelope.headSha}`;
      await persistDecisionRows(pool, context, input.authorization, effectIntentId);
      return { effectIntentId };
    },
    async recordLandReceipt(input: {
      authorization: LandAuthorization;
      effectIntentId: string;
      mainSha: string;
    }): Promise<{ auditId: string }> {
      // Audit D-R3.2: the writer is REQUIRED — the in-process `runWithOrgScope +
      // applyFinalizeLand` fallback was an unreachable half-measure once PR #714's
      // `runStateWriterFromEnv` always returned a writer.
      const { auditId } = await writer.finalizeLand(finalizeLandInputFrom(context, input.mainSha));
      await persistReceiptRow(pool, context, input.effectIntentId, input.mainSha, auditId);
      return { auditId };
    },
  };
}
