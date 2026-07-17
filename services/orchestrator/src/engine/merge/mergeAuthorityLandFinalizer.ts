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
  // in-16 — TRANSACTIONAL DELIVERY OUTBOX. On this authorized land, enqueue a durable
  // `delivery_runs` outbox row on the SAME in-transaction client as `merge.completed` +
  // the spec `merged` flip: all-or-nothing with the land record, so there is never a
  // "merged but nobody scheduled delivery" gap (integrations.md §F). NO external provider
  // call happens here — only the durable row; in-17's delivery DAG consumes it later.
  //
  // Keyed to the merge SHA + the authorizing decision (which pins the requirement/binding
  // generation via its proof). The id is DETERMINISTIC (`delivery-<authorityDecisionId>`),
  // and both the PK `(org_id, id)` and the `(org_id, project_id, authority_decision_id)`
  // unique index make the INSERT idempotent: a `merge_state_unknown` reconcile retry
  // re-runs this applier with the same key and `ON CONFLICT DO NOTHING` writes exactly
  // ONE row, never a duplicate. A throw here (e.g. the decision FK is absent) ROLLS BACK
  // the whole land record — never a half-written outbox row.
  await client.query(
    `INSERT INTO delivery_runs (org_id, id, project_id, authority_decision_id, merge_sha, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT DO NOTHING`,
    [input.orgId, `delivery-${input.authorityDecisionId}`, input.projectId, input.authorityDecisionId, input.mergeSha],
  );
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

/**
 * Project the land context + the resolved main sha + the authorizing decision id onto
 * the writer's `finalizeLand` op. The `authorityDecisionId` is what the in-16
 * transactional delivery outbox row is FK-bound to (see {@link applyFinalizeLand}); the
 * caller derives it from the authorization so it matches the decision row persisted in
 * step 1 (`persistDecisionRows`).
 */
function finalizeLandInputFrom(
  context: LandFinalizeContext,
  mainSha: string,
  authorityDecisionId: string,
): FinalizeLandInput {
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
    authorityDecisionId,
    auditEnvelope: context.auditEnvelope,
  };
}

/**
 * The deterministic `authority_decisions.id` for an authorization — IDENTICAL to the id
 * `persistDecisionRows` (step 1) inserts, so the in-16 delivery-outbox FK resolves the
 * decision row that authorized this exact land.
 */
function authorityDecisionIdFor(auth: LandAuthorization): string {
  return `decision-${auth.subject.id}-${auth.envelope.headSha}`;
}

/** Insert the authority_decisions + idempotent authority_effect_intents rows (step 1). */
async function persistDecisionRows(
  pool: pg.Pool,
  context: LandFinalizeContext,
  auth: LandAuthorization,
  effectIntentId: string,
): Promise<void> {
  const e = auth.envelope;
  const decisionId = authorityDecisionIdFor(auth);
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
      // in-16: the authorizing decision id (matching step 1's `persistDecisionRows`) rides
      // the finalize input so the delivery-outbox row it inserts is FK-bound to the decision.
      const { auditId } = await writer.finalizeLand(
        finalizeLandInputFrom(context, input.mainSha, authorityDecisionIdFor(input.authorization)),
      );
      await persistReceiptRow(pool, context, input.effectIntentId, input.mainSha, auditId);
      return { auditId };
    },
  };
}
