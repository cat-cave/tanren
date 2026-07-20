// in-11 — the DURABLE reconciliation saga + progress retry + state_unknown.
//
// The capability_prepare phase (in-9/in-10) enqueues `pending` rows onto
// `integration_reconciliations`. THIS is the consumer: a durable saga that claims a
// claimable reconciliation, OBSERVES the actual external state (`ReconcileProbe`),
// reconciles it against the desired state, and settles the row through the sole
// control-plane write seam (`IntegrationStateWriter`, in-4) — advancing on a
// confirmed convergence, retrying (PROGRESS-BASED, unbounded) while the observation
// keeps advancing, and FAIL-CLOSING to `state_unknown` when the external state is
// genuinely unconfirmable. Every scrap of progress lives durably on the row
// (`progress_signature` + `compensation_state.attemptHistory`), so a saga that
// crashed mid-flight resumes exactly where it left off: the writer's claim re-takes
// an expired-lease row, and the durable history feeds the same convergence decision.
//
// PRODUCTION INVOCATION: `drive(projectId)` is the reconcile stage of the DagWalker
// integration phase — it runs on every walk of an active project, immediately after
// capability_prepare enqueues (see `IntegrationLifecyclePhase`). Because that pass
// re-drives on every notify + periodic backstop re-walk, the saga is genuinely
// durable and re-entrant: each walk performs at most one attempt per claimable row
// (no in-process retry loop → no wall-clock, no counter cap), and the next walk
// continues the durable trajectory.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { canonicalJson, contentDigestOf } from "../contracts/cas.js";
import {
  DirectIntegrationStateWriter,
  type CompleteIntegrationReconciliationInput,
  type IntegrationReconciliationPhase,
  type IntegrationStateWriter,
} from "../contracts/integrationStateWriter.js";
import { createLogger } from "../observability/logger.js";
import type { AttemptSignature } from "../workflow/convergenceDetector.js";
import { CapabilityPrepareDriver } from "./capabilityPrepare.js";
import {
  PgReconciliationClaimSource,
  type ClaimedReconciliationRow,
  type ReconciliationClaimSource,
} from "./reconciliationClaimSource.js";
import { decideReconcile } from "./reconciliationDecision.js";
import { RecordedStateReconcileProbe, type ReconcileObservation, type ReconcileProbe } from "./reconcileProbe.js";

/** The per-attempt outcome for one reconciliation (drives counters + direct proof). */
export type ReconcileOutcome = "fixed_point" | "retry_scheduled" | "state_unknown" | "needs_attention" | "skipped";

export interface ReconcileSagaSummary {
  projectId: string;
  claimable: number;
  fixedPoint: number;
  retryScheduled: number;
  stateUnknown: number;
  needsAttention: number;
  skipped: number;
  readied: number;
}

export interface ReconciliationSagaOptions {
  /** The write seam (in-4). Defaults to the in-process control-plane writer over the pool. */
  readonly stateWriter?: IntegrationStateWriter;
  /** The external-state observation. Defaults to the recorded-snapshot production probe. */
  readonly probe?: ReconcileProbe;
  /** The queue read seam. Defaults to the pg-backed org-scoped reader. */
  readonly claimSource?: ReconciliationClaimSource;
  /** The claim lease, ms. A crashed worker's row becomes re-claimable once this elapses. */
  readonly leaseMs?: number;
  /** Progress-spaced retry SPACING (ms) — spacing only, never a cap/deadline. */
  readonly retrySpacingMs?: number;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_SPACING_MS = 15_000;

const log = createLogger("reconciliation-saga");

/**
 * The durable reconciliation saga. Pool-injected (mirrors `CapabilityPrepareDriver`);
 * resolves a project's org, then drives every claimable reconciliation for that
 * project through one attempt each.
 */
export class ReconciliationSagaDriver {
  private readonly stateWriter: IntegrationStateWriter;
  private readonly probe: ReconcileProbe;
  private readonly claimSource: ReconciliationClaimSource;
  private readonly leaseMs: number;
  private readonly retrySpacingMs: number;

  constructor(pool: pg.Pool, options: ReconciliationSagaOptions = {}) {
    this.stateWriter = options.stateWriter ?? new DirectIntegrationStateWriter(pool);
    this.probe = options.probe ?? new RecordedStateReconcileProbe(pool);
    this.claimSource = options.claimSource ?? new PgReconciliationClaimSource(pool);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.retrySpacingMs = options.retrySpacingMs ?? DEFAULT_RETRY_SPACING_MS;
  }

  /** Resolve the project's org, then drive its claimable reconciliations. */
  async drive(projectId: string): Promise<ReconcileSagaSummary> {
    const orgId = await this.claimSource.resolveOrgOrThrow(projectId);
    return this.driveForOrg(orgId, projectId);
  }

  /** Drive every claimable reconciliation for a KNOWN (org, project) — one attempt each. */
  async driveForOrg(orgId: string, projectId: string): Promise<ReconcileSagaSummary> {
    const claimable = await this.claimSource.selectClaimable(orgId, projectId);
    const summary: ReconcileSagaSummary = {
      projectId,
      claimable: claimable.length,
      fixedPoint: 0,
      retryScheduled: 0,
      stateUnknown: 0,
      needsAttention: 0,
      skipped: 0,
      readied: 0,
    };
    for (const id of claimable) {
      // Per-reconciliation isolation: one bad row never starves the rest of the sweep.
      let outcome: ReconcileOutcome;
      try {
        outcome = await this.driveOne(orgId, id);
      } catch (error) {
        log.error("reconciliation saga attempt failed; next walk retries", { orgId, projectId, id }, error);
        continue;
      }
      tally(summary, outcome);
    }
    // Derive the capability-node advance from the DURABLE reconciliation state, so a
    // crash between settling `fixed_point` and readying the node self-heals next walk.
    summary.readied = await this.claimSource.settleReadyCapabilityNodes(orgId, projectId);
    return summary;
  }

  /**
   * Drive ONE reconciliation through a single durable attempt. Claims it (attempt++,
   * emits reconcile.started), observes the external state (a thrown probe = fail-closed
   * unconfirmable), decides the transition from the durable history, and settles it.
   * Returns `skipped` when the row was not actually claimable (lost race / already terminal).
   */
  async driveOne(orgId: string, reconciliationId: string): Promise<ReconcileOutcome> {
    const claimOwner = `reconcile:${randomUUID()}`;
    const claimed = await this.stateWriter.claim({ orgId, reconciliationId, claimOwner, leaseMs: this.leaseMs });
    if (claimed === undefined) return "skipped";

    const row = await this.claimSource.readClaimed(orgId, reconciliationId);
    if (row === undefined) return "skipped";

    // FAIL-CLOSED on a malformed persisted phase (a corrupt/unknown value must not be
    // silently cast and driven). The DB CHECK makes this unreachable in practice; if it
    // is ever reached, halt for attention rather than reconcile against a bad coordinate.
    const phase = parseReconciliationPhase(row.phase);
    if (phase === undefined) {
      await this.markStateUnknown(orgId, reconciliationId, claimOwner, `invalid_reconciliation_phase:${row.phase}`, {
        phase: row.phase,
      });
      return "state_unknown";
    }

    const observation = await this.observeFailClosed(buildContext(orgId, row, phase));
    return this.settleObservation(orgId, reconciliationId, claimOwner, row, observation);
  }

  /** Interpret an observation via the durable history and write the resulting transition. */
  private async settleObservation(
    orgId: string,
    reconciliationId: string,
    claimOwner: string,
    row: ClaimedReconciliationRow,
    observation: ReconcileObservation,
  ): Promise<ReconcileOutcome> {
    const decision = decideReconcile(observation, parseAttemptHistory(row.compensationState));
    const base = { orgId, reconciliationId, claimOwner };
    switch (decision.action) {
      case "fixed_point":
        return this.completeOrRecordUnknown(
          {
            ...base,
            status: "fixed_point",
            progressSignature: signatureDigest(decision.signature),
            compensationState: { attemptHistory: decision.history },
            observedState: observation.observedState,
          },
          "fixed_point",
        );
      case "retry":
        return this.completeOrRecordUnknown(
          {
            ...base,
            status: "retry_scheduled",
            retryAfterMs: this.retrySpacingMs,
            progressSignature: signatureDigest(decision.signature),
            compensationState: { attemptHistory: decision.history },
            observedState: observation.observedState,
          },
          "retry_scheduled",
        );
      case "needs_attention":
        return this.completeOrRecordUnknown(
          {
            ...base,
            status: "needs_attention",
            progressSignature: signatureDigest(decision.signature),
            failureClassification: decision.classification,
            compensationState: { attemptHistory: decision.history },
            observedState: observation.observedState,
          },
          "needs_attention",
        );
      case "state_unknown":
        await this.markStateUnknown(
          orgId,
          reconciliationId,
          claimOwner,
          decision.classification,
          observation.observedState,
        );
        return "state_unknown";
      default:
        return assertNeverAction(decision);
    }
  }

  /**
   * Complete the reconciliation, honoring the writer's claim-fence boolean. `complete`
   * returns false when this owner no longer holds the live claim (lease expired / the
   * row was re-claimed / already settled). In that case we MUST NOT report success — a
   * lost-claim settle fail-closes to `state_unknown` (the provisioningPersistence
   * discipline), so a later reclaim cannot advance on a stale in-flight observation.
   */
  private async completeOrRecordUnknown(
    input: CompleteIntegrationReconciliationInput,
    successOutcome: ReconcileOutcome,
  ): Promise<ReconcileOutcome> {
    const completed = await this.stateWriter.complete(input);
    if (completed) return successOutcome;
    log.error("reconcile complete lost its claim mid-settle; recording state_unknown", {
      orgId: input.orgId,
      reconciliationId: input.reconciliationId,
      status: input.status,
    });
    await this.markStateUnknown(
      input.orgId,
      input.reconciliationId,
      input.claimOwner,
      `claim_lost_during_settle:${input.status}`,
      input.observedState ?? {},
    );
    return "state_unknown";
  }

  /**
   * The ambiguous halt: record `state_unknown`, do NOT advance. Fenced to this owner's
   * live claim; if the lease was lost mid-observation, the claim-lost variant still
   * records the ambiguity (against a still-claimed row) rather than letting the row look
   * resolved or assuming success.
   */
  private async markStateUnknown(
    orgId: string,
    reconciliationId: string,
    claimOwner: string,
    classification: string,
    observedState: Record<string, unknown>,
  ): Promise<void> {
    const marked = await this.stateWriter.stateUnknown({
      orgId,
      reconciliationId,
      claimOwner,
      failureClassification: classification,
      observedState,
    });
    if (!marked) {
      await this.stateWriter.stateUnknownAfterClaimLost({
        orgId,
        reconciliationId,
        claimOwner,
        failureClassification: classification,
        observedState,
      });
    }
  }

  /** Observe the external state; a THROWN probe is treated as fail-closed unconfirmable. */
  private async observeFailClosed(context: Parameters<ReconcileProbe["observe"]>[0]): Promise<ReconcileObservation> {
    try {
      return await this.probe.observe(context);
    } catch (error) {
      log.error("reconcile probe threw; treating external state as unconfirmable", { ...context }, error);
      return {
        kind: "unconfirmable",
        classification: "provider_observation_error",
        observedState: { probeError: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}

/**
 * The composite DagWalker integration phase: run capability_prepare (in-9/in-10) to
 * enqueue reconciliations, then immediately drive the reconciliation saga (in-11) so a
 * freshly-enqueued reconciliation is attempted in the same walk. Both halves are
 * durable + idempotent, so the always-on walk + backstop cadence is the saga's
 * re-drive loop — no in-process retry loop, no timer.
 */
export class IntegrationLifecyclePhase {
  private readonly prepareDriver: CapabilityPrepareDriver;
  private readonly saga: ReconciliationSagaDriver;

  constructor(pool: pg.Pool, options: ReconciliationSagaOptions = {}) {
    this.prepareDriver = new CapabilityPrepareDriver(pool);
    this.saga = new ReconciliationSagaDriver(pool, options);
  }

  async prepare(projectId: string): Promise<{ prepare: unknown; reconcile: ReconcileSagaSummary }> {
    const prepare = await this.prepareDriver.prepare(projectId);
    const reconcile = await this.saga.drive(projectId);
    return { prepare, reconcile };
  }
}

/** Exhaustiveness guard — the decision union is closed; a new arm is a compile error. */
function assertNeverAction(decision: never): never {
  throw new Error(`unhandled reconcile decision: ${JSON.stringify(decision)}`);
}

const RECONCILIATION_PHASES: ReadonlySet<string> = new Set<IntegrationReconciliationPhase>([
  "discover",
  "authorize",
  "select",
  "provision",
  "bind",
  "observe",
  "materialize",
  "reconcile",
  "teardown",
]);

/** Parse a persisted phase against the known enum; unknown → undefined (fail-closed upstream). */
function parseReconciliationPhase(phase: string): IntegrationReconciliationPhase | undefined {
  return RECONCILIATION_PHASES.has(phase) ? (phase as IntegrationReconciliationPhase) : undefined;
}

function buildContext(
  orgId: string,
  row: ClaimedReconciliationRow,
  phase: IntegrationReconciliationPhase,
): Parameters<ReconcileProbe["observe"]>[0] {
  return {
    orgId,
    projectId: row.projectId,
    requirementId: row.requirementId,
    phase,
    attempt: row.attempt,
    bindingId: row.bindingId,
    bindingGeneration: row.bindingGeneration,
    desiredStateHash: row.requestFingerprint,
  };
}

/** The durable sha256 progress signature for a canonical attempt signature (CHECK-compliant). */
function signatureDigest(signature: AttemptSignature): string {
  const body = canonicalJson({
    failureSignature: signature.failureSignature,
    ...(signature.workSignature === undefined ? {} : { workSignature: signature.workSignature }),
    ...(signature.magnitude === undefined ? {} : { magnitude: signature.magnitude }),
  });
  return contentDigestOf(new TextEncoder().encode(body));
}

/** Parse the durable attempt history off `compensation_state` defensively. */
function parseAttemptHistory(compensationState: unknown): AttemptSignature[] {
  if (compensationState === null || typeof compensationState !== "object") return [];
  const raw = (compensationState as Record<string, unknown>)["attemptHistory"];
  if (!Array.isArray(raw)) return [];
  const history: AttemptSignature[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const failureSignature = rec["failureSignature"];
    if (typeof failureSignature !== "string") continue;
    const signature: AttemptSignature = { failureSignature };
    if (typeof rec["workSignature"] === "string") signature.workSignature = rec["workSignature"];
    if (typeof rec["magnitude"] === "number") signature.magnitude = rec["magnitude"];
    history.push(signature);
  }
  return history;
}

function tally(summary: ReconcileSagaSummary, outcome: ReconcileOutcome): void {
  switch (outcome) {
    case "fixed_point":
      summary.fixedPoint += 1;
      break;
    case "retry_scheduled":
      summary.retryScheduled += 1;
      break;
    case "state_unknown":
      summary.stateUnknown += 1;
      break;
    case "needs_attention":
      summary.needsAttention += 1;
      break;
    case "skipped":
      summary.skipped += 1;
      break;
  }
}
