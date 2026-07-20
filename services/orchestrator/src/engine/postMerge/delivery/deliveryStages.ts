// The nine delivery-stage executors. Each RETURNS a {@link StageOutcome} — `confirmed`
// only when the stage's external effect is OBSERVED (or the stage is a legitimate no-op
// for this project), `degraded` when it cannot be confirmed. Executors REUSE the existing
// idempotent seams rather than reinvent them:
//   • reconcile_binding → in-11 reconciliation saga (production binding reconcile).
//   • mint_lease        → VaultTokenMinter (activation-scoped lease over the project's
//                         provisioned production secret refs); fail-closed when product
//                         secrets exist but no scoped-lease backend is available.
//   • materialize_env / attach_runtime / deploy / verify_deploy → the idempotent
//                         DeployOnMergeWatcher (materialize+prove → attach → trigger →
//                         verify, in that doctrinal order), each stage CONFIRMED from its
//                         durable event-trail signal.
//   • stimulate / observe → the idempotent DemoOnDeployWatcher (establish Given → perform
//                         When → independently observe the Then), confirmed from the demo
//                         trail.
//   • record_evidence   → the fail-closed signed-evidence completion gate.
//
// The deploy/demo cluster effect runners are invoked AT MOST ONCE per drive (memoized);
// their throw is captured (not propagated) so stage confirmation reads the DURABLE truth
// from the signal port, and a partial cluster naturally degrades at the first unconfirmed
// stage. Resume re-runs the idempotent runner, which internally resumes (e.g. verify-only).
// Every DB read goes through the injected {@link DeliverySignals} port, so these executors
// are unit-testable with a fake — no DB reaches this module.

import type { VaultTokenMinter } from "../../contracts/vaultTokenMinter.js";
import { createLogger } from "../../observability/logger.js";
import type { DeployTriggerGate } from "../deployTriggerGate.js";
import type { RunMergeWatcher } from "../subscriber.js";
import type { DeliverySignals, DemoReach, DeployReach } from "./deliverySignals.js";
import {
  appendDeliveryCompleted,
  appendDemoStimulusAborted,
  appendDemoStimulusStarted,
  type ObservedEffect,
  type RecordEvidenceDeps,
} from "./deliveryEvidence.js";
import { confirmed, degraded, type DeliveryLineage, type DeliveryStage, type StageOutcome } from "./stageModel.js";

const log = createLogger("delivery-dag");

/** The in-11 reconciliation saga surface the reconcile_binding stage drives (structural). */
export interface ReconcileSagaLike {
  driveForOrg(orgId: string, projectId: string): Promise<{ stateUnknown: number; needsAttention: number }>;
}

export interface DeliveryStageDeps {
  /** The durable-signal port (production `PgDeliverySignals`; a fake in unit tests). */
  readonly signals: DeliverySignals;
  /** The idempotent deploy-on-merge effect runner (materialize → attach → trigger → verify). */
  readonly deployRunner: RunMergeWatcher;
  /** The idempotent demo-on-deploy effect runner (establish → perform → observe). */
  readonly demoRunner: RunMergeWatcher;
  /** The in-11 production-binding reconciliation saga. */
  readonly saga: ReconcileSagaLike;
  /** The evidence writer + signer for the record_evidence gate. */
  readonly evidence: RecordEvidenceDeps;
  /**
   * Cross-process advisory-lock gate for the demo effect (deploy's `PgDeployTriggerGate`
   * pattern): only ONE worker fires the demo stimulus at a time. Prevents a concurrent
   * (multi-process) double-fire of the live behavior effect.
   */
  readonly demoGate: DeployTriggerGate;
  /** Optional activation-scoped Vault lease minter; absent ⇒ mint_lease no-ops unless product secrets exist. */
  readonly minter?: VaultTokenMinter;
}

/** Per-drive memo: the cluster runners fire at most once; their throw is captured. */
export interface DriveMemo {
  deployRunnerInvoked: boolean;
  deployRunnerThrew: boolean;
  demoRunnerInvoked: boolean;
  demoRunnerThrew: boolean;
  /**
   * This drive found the durable demo INTENT MARKER present without a terminal demo event —
   * the effect MAY have fired mid-crash, so this drive refused to re-fire (fail-closed).
   */
  demoInFlightUnknown: boolean;
  /** Another worker holds the demo advisory lock (a concurrent demo is firing elsewhere). */
  demoLockHeld: boolean;
}

export function newDriveMemo(): DriveMemo {
  return {
    deployRunnerInvoked: false,
    deployRunnerThrew: false,
    demoRunnerInvoked: false,
    demoRunnerThrew: false,
    demoInFlightUnknown: false,
    demoLockHeld: false,
  };
}

/** The activation lease credential lifetime (a Vault lease TTL, not a work deadline). */
const ACTIVATION_LEASE_TTL_SECONDS = 3600;

/** The stage names an all-confirmed delivery records as its causal chain (through observe). */
const STAGES_UP_TO_EVIDENCE = [
  "reconcile_binding",
  "mint_lease",
  "materialize_env",
  "attach_runtime",
  "deploy",
  "verify_deploy",
  "stimulate",
  "observe",
] as const;

export class DeliveryStages {
  constructor(private readonly deps: DeliveryStageDeps) {}

  /** Run one stage. Called by the driver only for stages not already durably succeeded. */
  async run(
    stage: DeliveryStage,
    lineage: DeliveryLineage,
    deliveryRunId: string,
    memo: DriveMemo,
  ): Promise<StageOutcome> {
    switch (stage) {
      case "reconcile_binding":
        return this.reconcileBinding(lineage);
      case "mint_lease":
        return this.mintLease(lineage);
      case "materialize_env":
      case "attach_runtime":
      case "deploy":
      case "verify_deploy":
        return this.deployClusterStage(stage, lineage, memo);
      case "stimulate":
      case "observe":
        return this.demoClusterStage(stage, lineage, deliveryRunId, memo);
      case "record_evidence":
        return this.recordEvidence(lineage, deliveryRunId, memo);
      default:
        throw new Error(`delivery-dag: unknown stage '${String(stage)}'`);
    }
  }

  private async reconcileBinding(lineage: DeliveryLineage): Promise<StageOutcome> {
    const summary = await this.deps.saga.driveForOrg(lineage.orgId, lineage.projectId);
    if (summary.stateUnknown > 0 || summary.needsAttention > 0) {
      return degraded(
        "binding_reconcile_unconfirmed",
        `production binding reconcile did not converge (state_unknown=${summary.stateUnknown}, needs_attention=${summary.needsAttention})`,
      );
    }
    return confirmed;
  }

  private async mintLease(lineage: DeliveryLineage): Promise<StageOutcome> {
    const refs = await this.deps.signals.provisionedProductionSecretRefs(lineage);
    // No provisioned production secrets ⇒ nothing to scope ⇒ a legitimate no-op.
    if (refs.length === 0) return confirmed;
    // Product secrets exist but no scoped-lease backend is wired: fail CLOSED (risk-369 —
    // a non-scoped backend would bypass credential deprivileging), never a silent pass.
    if (this.deps.minter === undefined) {
      return degraded(
        "scoped_lease_backend_unavailable",
        "production provisioned secrets require an activation-scoped lease but no scoped-lease minter is available",
      );
    }
    try {
      // Mint the activation-scoped child lease over EXACTLY the project's production secret
      // refs (read-only; no write-back on a delivery activation). The token value is never
      // logged/persisted — only the mint proves the scoped credential is obtainable.
      await this.deps.minter.mintScopedRunToken({
        runId: lineage.runId,
        orgId: lineage.orgId,
        credentialRefPaths: refs,
        ttlSeconds: ACTIVATION_LEASE_TTL_SECONDS,
        numUses: refs.length + 1,
      });
      return confirmed;
    } catch (error) {
      log.error("mint_lease failed", { runId: lineage.runId, projectId: lineage.projectId }, error);
      return degraded(
        "scoped_lease_mint_failed",
        "activation-scoped lease could not be minted for the provisioned secrets",
      );
    }
  }

  private async deployClusterStage(
    stage: DeliveryStage,
    lineage: DeliveryLineage,
    memo: DriveMemo,
  ): Promise<StageOutcome> {
    await this.ensureDeployClusterDriven(lineage, memo);
    const reach = await this.deps.signals.deployReach(lineage, memo.deployRunnerThrew);
    return outcomeForDeployStage(stage, reach);
  }

  private async demoClusterStage(
    stage: DeliveryStage,
    lineage: DeliveryLineage,
    deliveryRunId: string,
    memo: DriveMemo,
  ): Promise<StageOutcome> {
    await this.ensureDemoClusterDriven(lineage, deliveryRunId, memo);
    // FAIL-CLOSED demo idempotency (Finding 1): the durable INTENT MARKER was present without
    // a terminal demo event ⇒ the effect MAY have fired mid-crash ⇒ DEGRADE rather than
    // re-fire (a committed external effect is never re-run). A never-fired demo has NO intent
    // marker, so it does NOT reach here — it fires and can complete.
    if (memo.demoInFlightUnknown) {
      return degraded(
        "demo_effect_in_flight_unknown",
        "a prior demo stimulus recorded a fire-intent but no terminal outcome; refusing to re-fire",
      );
    }
    // Another worker holds the demo advisory lock (a concurrent demo is firing elsewhere) —
    // degrade this pass; the live owner's demo will produce the terminal, and a later wake reads it.
    if (memo.demoLockHeld) {
      return degraded(
        "demo_locked_elsewhere",
        "another worker holds the demo advisory lock; this pass did not fire the demo",
      );
    }
    const deployReach = await this.deps.signals.deployReach(lineage, memo.deployRunnerThrew);
    const demoReach = await this.deps.signals.demoReach(lineage, deployReach);
    return outcomeForDemoStage(stage, demoReach);
  }

  private async ensureDeployClusterDriven(lineage: DeliveryLineage, memo: DriveMemo): Promise<void> {
    if (memo.deployRunnerInvoked) return;
    memo.deployRunnerInvoked = true;
    try {
      await this.deps.deployRunner.check(lineage.runId);
    } catch (error) {
      // The runner records its own durable deploy.failed/deploy.skipped; capture the throw
      // so stage confirmation reads the durable event truth (fail-closed at the real stage).
      memo.deployRunnerThrew = true;
      log.error("deploy cluster runner failed", { runId: lineage.runId }, error);
    }
  }

  /**
   * Drive the demo effect AT MOST ONCE per drive, with a TIGHT effect-boundary intent marker
   * (Finding HIGH — a never-fired demo must RE-FIRE, only a genuine crash mid-dispatch may
   * degrade):
   *  1. A terminal demo event already exists ⇒ committed; do NOT re-invoke.
   *  2. Else acquire the cross-process advisory lock (serializes concurrent fires); not
   *     acquired ⇒ demoLockHeld (degrade this pass; a later wake re-checks).
   *  3. UNDER the lock: a terminal now exists ⇒ return; a LIVE fire-intent (started > aborted)
   *     without a terminal ⇒ a genuine crash mid-dispatch ⇒ demoInFlightUnknown, never re-fire.
   *  4. Only a VERIFIED deploy has a live surface (a no-op demo records NO intent and never
   *     false-degrades). Record the fire-intent (RESILIENT: a post-commit notify failure whose
   *     durable INSERT landed is treated as success); if the intent can't be recorded at all,
   *     do NOT fire (re-fire next wake). Fire the runner. Then RESOLVE: if the runner left NO
   *     terminal demo event (proving the external effect never dispatched — the only pre-terminal
   *     awaitable is a pure read), append the ABORT marker so the intent is not live ⇒ re-fire.
   */
  private async ensureDemoClusterDriven(
    lineage: DeliveryLineage,
    deliveryRunId: string,
    memo: DriveMemo,
  ): Promise<void> {
    if (memo.demoRunnerInvoked) return;
    memo.demoRunnerInvoked = true;

    // Fast path: the effect already committed — reach reads the terminal; no lock needed.
    if (await this.deps.signals.demoTerminalExists(lineage)) return;

    const gate = await this.deps.demoGate.run(lineage.runId, async () => {
      // Authoritative re-checks UNDER the lock (another worker may have raced to fire).
      if (await this.deps.signals.demoTerminalExists(lineage)) return;
      if (await this.deps.signals.demoStimulusIntentLive(lineage)) {
        // A live fire-intent with no terminal ⇒ the effect may have dispatched mid-crash — never re-fire.
        memo.demoInFlightUnknown = true;
        return;
      }
      // A non-verified deploy has no live surface: the runner is a clean no-op — fire it (no-op)
      // and record NO intent, so a resume never false-degrades a no-op demo.
      const deployReach = await this.deps.signals.deployReach(lineage, memo.deployRunnerThrew);
      if (deployReach !== "verified") {
        await this.fireDemoRunner(lineage, memo);
        return;
      }
      // Verified: record the fire-intent immediately before the dispatch. RESILIENT to a
      // post-commit notify failure (the durable INSERT is source of truth); a pre-commit
      // failure leaves NO live intent ⇒ do NOT fire (re-fire next wake).
      if (!(await this.recordFireIntentDurably(lineage, deliveryRunId))) {
        memo.demoRunnerThrew = true;
        return;
      }
      await this.fireDemoRunner(lineage, memo);
      // RESOLVE the intent: alive + NO terminal ⇒ the effect never dispatched (a pre-dispatch
      // read failed / no-op) ⇒ clear the intent so re-entry re-fires. A crash before here leaves
      // the live intent ⇒ degrade.
      if (!(await this.deps.signals.demoTerminalExists(lineage))) {
        await this.abortFireIntent(lineage, deliveryRunId, "no_terminal_after_run");
      }
    });
    if (!gate.acquired) memo.demoLockHeld = true;
  }

  private async fireDemoRunner(lineage: DeliveryLineage, memo: DriveMemo): Promise<void> {
    try {
      await this.deps.demoRunner.check(lineage.runId);
    } catch (error) {
      memo.demoRunnerThrew = true;
      log.error("demo cluster runner failed", { runId: lineage.runId }, error);
    }
  }

  /** Append the fire-intent, tolerating a post-commit notify failure (durable INSERT wins). */
  private async recordFireIntentDurably(lineage: DeliveryLineage, deliveryRunId: string): Promise<boolean> {
    try {
      await appendDemoStimulusStarted(this.deps.evidence, lineage, deliveryRunId);
      return true;
    } catch (error) {
      // The INSERT may have committed before a NOTIFY/connection failure (orgScopingPool runs
      // each statement in its own txn). Since no live intent existed before this append, a live
      // intent now proves the durable row landed — treat it as success.
      if (await this.deps.signals.demoStimulusIntentLive(lineage)) {
        log.error(
          "demo fire-intent notify failed post-commit; proceeding on the durable row",
          { runId: lineage.runId },
          error,
        );
        return true;
      }
      log.error("demo fire-intent could not be recorded; will re-fire next wake", { runId: lineage.runId }, error);
      return false;
    }
  }

  private async abortFireIntent(lineage: DeliveryLineage, deliveryRunId: string, reason: string): Promise<void> {
    try {
      await appendDemoStimulusAborted(this.deps.evidence, lineage, deliveryRunId, reason);
    } catch (error) {
      // Best-effort: a rare abort-append failure leaves a live intent ⇒ a conservative degrade
      // next wake (fail-closed, never a double-fire).
      log.error("demo fire-intent abort could not be recorded", { runId: lineage.runId }, error);
    }
  }

  private async recordEvidence(
    lineage: DeliveryLineage,
    deliveryRunId: string,
    memo: DriveMemo,
  ): Promise<StageOutcome> {
    // FAIL-CLOSED: a product integration whose behavior must be observed post-deploy to
    // release cannot yet prove its A3 Then (the independent provider-effect probe is not
    // built on `main`). Such a delivery must degrade, never report a complete it cannot
    // evidence. The common path (no such requirement) has zero rows and proceeds.
    const releaseRequired = await this.deps.signals.releaseRequiredCount(lineage);
    if (releaseRequired > 0) {
      return degraded(
        "product_integration_effect_unobservable",
        `${releaseRequired} product integration(s) require independent post-deploy effect observation, which is not yet available`,
      );
    }
    const deployReach = await this.deps.signals.deployReach(lineage, memo.deployRunnerThrew);
    const demoReach = await this.deps.signals.demoReach(lineage, deployReach);
    const observedEffect = observedEffectFor(deployReach, demoReach);
    // Resume idempotency: if the signed attestation already exists, do not double-emit.
    if (!(await this.deps.signals.deliveryCompletedExists(lineage))) {
      const deploymentId = await this.deps.signals.verifiedDeploymentId(lineage);
      await appendDeliveryCompleted(this.deps.evidence, {
        lineage,
        deliveryRunId,
        observedEffect,
        deploymentId,
        stagesConfirmed: STAGES_UP_TO_EVIDENCE,
      });
    }
    return confirmed;
  }
}

/**
 * Map a deploy-cluster stage to its outcome given the durably-observed reach. `none` (no
 * deploy configured) confirms every cluster stage as a no-op. Otherwise a stage confirms
 * only when the trail proves it was reached, and the FIRST unreached stage degrades.
 */
export function outcomeForDeployStage(stage: DeliveryStage, reach: DeployReach): StageOutcome {
  if (reach === "none") return confirmed;
  const reachedThrough: Record<Exclude<DeployReach, "none">, DeliveryStage[]> = {
    expected: [],
    attached: ["materialize_env", "attach_runtime"],
    triggered: ["materialize_env", "attach_runtime", "deploy"],
    verified: ["materialize_env", "attach_runtime", "deploy", "verify_deploy"],
  };
  if (reachedThrough[reach].includes(stage)) return confirmed;
  return degraded(
    `deploy_${stage}_unconfirmed`,
    `deploy cluster reached '${reach}'; stage '${stage}' not yet confirmed`,
  );
}

/**
 * Map a demo/A3 stage to its outcome given the demo reach. `none` (no verified deploy —
 * nothing live to observe) confirms both as a no-op; `observed` confirms both; `failed`
 * confirms stimulate (it ran) but degrades observe (effect NOT confirmed); `expected`
 * degrades stimulate (the demo has not produced evidence yet).
 */
export function outcomeForDemoStage(stage: DeliveryStage, reach: DemoReach): StageOutcome {
  if (reach === "none" || reach === "observed") return confirmed;
  if (reach === "failed") {
    return stage === "stimulate"
      ? confirmed
      : degraded("demo_effect_not_observed", "the deployed behavior stimulus ran but its effect was not confirmed");
  }
  // expected: deploy verified but the demo has not produced a terminal outcome yet.
  return degraded("demo_evidence_pending", "the demo has not yet independently observed the deployed behavior");
}

/** The independently-observed external effect, derived from the deploy + demo reach. */
export function observedEffectFor(deployReach: DeployReach, demoReach: DemoReach): ObservedEffect {
  if (demoReach === "observed") return "demo_observed";
  if (deployReach === "verified") return "deploy_verified";
  return "none";
}
