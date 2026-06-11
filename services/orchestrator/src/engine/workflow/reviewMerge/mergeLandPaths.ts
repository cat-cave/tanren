// The LAND path the merge stage's `directMerge` dispatches to (§5 cutover), extracted
// from `MergeDispatcher` to keep each file under the 500-line cap:
//   - `landViaAuthority` — the GUARANTEED + ONLY land: run the fail-closed
//     `MergeAuthority` truth table, land the authorized commit via
//     `CodeHost.landAuthorizedRef` (the ff-only CAS), and map the disposition onto the
//     merge stage's event vocabulary.
//
// It operates on the dispatcher's `DispatcherDeps` + a small {@link LandOps} surface
// (the shared event/finalize/result helpers the dispatcher owns), so the land logic
// is one cohesive module without duplicating those helpers.

import { runAuthorityLand } from "../../merge/mergeAuthorityGate.js";
import { evaluatePostureGate } from "../../forge/audits/postureGate.js";
import type { AuditEnvelope } from "../../events/schemas/audit.js";
import type { PullRequestMergeability } from "../../contracts/codeHostTypes.js";
import type { MergeAuthorityBundle, MergeForRunResult, MergeOutcomeKind } from "./mergeDispatchTypes.js";
import type { DispatcherDeps } from "./mergeDispatcher.js";

/**
 * THE ONE BASE-SHIFT HANDLER (tanren-owns-the-engine.md §7): rebase a `behind` branch
 * onto its base through the unified `baseShiftRebase` hook (`BaseShiftCoordinator.rebaseOnto`
 * — the SAME path change-percolation uses; the two divergent base-shift handlers collapse
 * into ONE). The hook is now UNCONDITIONAL on every land-driving caller (the in-loop
 * `direct_merge` path AND the native_queue DRIVE pass both wire it; decomposition PR-7 /
 * §5h) — the legacy server-side `probe.updateBranch()` fallback is GONE. An absent hook is
 * a fail-closed HOLD (a wiring bug — never a silent server-side update), never a proceed.
 * Extracted as a free function to keep the dispatcher under the 500-line cap.
 */
export async function rebaseBehindBranch(
  deps: DispatcherDeps,
  mergeability: PullRequestMergeability,
): Promise<{
  outcome: "rebased" | "up_to_date" | "conflict" | "held";
  message?: string;
  // COMMIT-BINDING (§5): the rebased PR head sha the dispatcher anchors the re-gate
  // verdict on. Present via the unified `baseShiftRebase` hook; the re-gate fails closed
  // rather than binding wrong when a hook returns no head sha.
  rebasedHeadSha?: string;
}> {
  const { input, context } = deps;
  if (input.baseShiftRebase === undefined) {
    // FAIL-CLOSED: the unified base-shift hook is REQUIRED on every land-driving caller. Its
    // absence is a wiring bug, not a license to server-side update-branch — HOLD (recoverable),
    // never a silent merge of a stale/unverified rebase.
    return { outcome: "held", message: "base-shift rebase hook is not wired — cannot rebase a behind branch (held)" };
  }
  const head = mergeability.headBranch;
  return input.baseShiftRebase({
    runId: context.runId,
    baseBranch: mergeability.baseBranch || context.baseBranch,
    ...(head !== "" && head !== undefined && { headBranch: head }),
  });
}

/**
 * The shared dispatcher operations the land path reuses (the event base, the PR
 * fields, the audit envelope, the integration label, the task finalize, the result
 * shape, and the recoverable-conflict emit). Implemented by
 * `MergeDispatcher`; passed to the extracted path so it does not re-derive any of it.
 */
export interface LandOps {
  base(): { runId: string; specId: string; projectId: string; taskId: string };
  prFields(): { prUrl: string; prNumber: number };
  auditEnvelope(): AuditEnvelope;
  mergeLabel(): "direct_merge" | "native_queue";
  finalize(
    outcome: MergeOutcomeKind,
    state: {
      taskOutcome: "ok" | "failed" | "pending";
      taskStatus: "done" | "failed" | "running";
      failureKind?: string;
    },
  ): Promise<void>;
  result(outcome: MergeOutcomeKind, extra?: { mergeSha?: string; message?: string }): MergeForRunResult;
  emitConflict(message: string, headBranch?: string): Promise<MergeForRunResult>;
}

/**
 * The GUARANTEED land (§5): read the dispatcher-owned mergeability, run the authority
 * truth table + host CAS land, then map the disposition onto the merge stage's
 * outcomes — `merged` finalizes the task (the LandFinalizer already recorded
 * `merge.completed` + the spec flip transactionally); `needs_attention` PARKS the spec
 * via the escalator (a genuine human decision); `blocked` holds RECOVERABLY (a transient
 * authority refusal the recovery surface re-drives — NEVER a terminal dequeue, §3.2); a
 * benign CAS race is REBASED-then-retried natively (§3.3); `merge_state_unknown` holds
 * LOUDLY for reconciliation (never a silent inconsistency).
 */
export async function landViaAuthority(
  deps: DispatcherDeps,
  ops: LandOps,
  bundle: MergeAuthorityBundle,
): Promise<MergeForRunResult> {
  return landViaAuthorityAttempt(deps, ops, bundle, 0);
}

/**
 * One authority-land attempt. `casRetries` bounds the native rebase-on-CAS re-drive
 * (§3.3) so a persistently-racing main can never loop forever: after the bound it holds
 * recoverably rather than re-rebasing without end.
 */
async function landViaAuthorityAttempt(
  deps: DispatcherDeps,
  ops: LandOps,
  bundle: MergeAuthorityBundle,
  casRetries: number,
): Promise<MergeForRunResult> {
  const { context, pr } = deps;
  // §5h: the freshness signal the authority gates on is the `CodeHost`-derived ancestry
  // (`clean`/`behind`/`unknown`) — never the GitHub `mergeable_state`. Only `clean` clears.
  const mergeability = await deps.probe.readFreshness();
  const disposition = await runAuthorityLand({
    bundle,
    mergeability,
    context: {
      repo: { owner: pr.repo.owner, name: pr.repo.name },
      intoMain: context.baseBranch,
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      taskId: deps.taskId,
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
    },
    integration: ops.mergeLabel(),
    auditEnvelope: ops.auditEnvelope(),
  });

  switch (disposition.kind) {
    case "merged": {
      await ops.finalize("merged", { taskOutcome: "ok", taskStatus: "done" });
      // The merge was NOT blocked — so any residual (below-`blockReviewAt`) P2/P3
      // findings are handled per the project posture (§4): route-to-dag emits
      // them as new DAG specs; fix-if-idle carries them forward (the land just merged,
      // so the spec is no longer idle-awaiting-review). Record the disposition.
      await recordPostureRouting(deps, ops, bundle);
      return ops.result("merged", { mergeSha: disposition.mainSha });
    }
    case "needs_attention": {
      // A GENUINE human decision (HITL pending / changes_requested at land time). PARK the
      // spec via the SpecEscalator (the `needs_attention` outcome maps to the coordinator's
      // park-then-dequeue) so it frees its slot rather than hot-holding the queue head
      // forever. NOT recoverable `blocked` — a human must make the call.
      await emitAuthorityBlocked(deps, ops, disposition.reasons);
      await ops.finalize("blocked", { taskOutcome: "pending", taskStatus: "running" });
      return ops.result("needs_attention", { message: disposition.reasons.join("; ") });
    }
    case "blocked": {
      // §3.2: a TRANSIENT authority refusal (a not-yet-converged signal: gate pending,
      // budget momentarily unresolved, a mergeability re-read race). RECOVERABLE — emit
      // `merge.blocked` + hold the task running so the recovery surface re-drives. The old
      // `emitConflict` here finalized a TERMINAL `merge.dequeued(reason:"conflict")` that
      // `recoverDequeuedCandidates` never recovers — permanently stranding the spec + every
      // dependent. Recoverable `blocked` is the SAME finalize the needs_attention arm uses,
      // mapped by the coordinator to a bounded recoverable hold (NOT a terminal dequeue).
      await emitAuthorityBlocked(deps, ops, disposition.reasons);
      await ops.finalize("blocked", { taskOutcome: "pending", taskStatus: "running" });
      return ops.result("blocked", { message: `land blocked by authority: ${disposition.reasons.join("; ")}` });
    }
    case "cas_rejected":
      // §3.3: main advanced underneath (a batch sibling landed first). This is a
      // NATIVE-ANCESTRY decision — rebase the head onto the now-advanced base, re-gate the
      // rebased tree, and re-attempt the land — NOT a GitHub-`behind`-state-dependent path
      // (an unprotected repo never reports `behind`, so the old `emitConflict` terminally
      // dequeued the 2nd batch member). Bounded by `casRetries`; the fallback is a
      // recoverable hold, never a terminal dequeue.
      return rebaseOnCasAndRetry(deps, ops, bundle, mergeability, disposition.reason, casRetries);
    case "merge_state_unknown": {
      // The host advanced `main` but the durable record FAILED — NEVER a silent
      // inconsistency: hold loudly for reconciliation.
      await deps.eventStore.append({
        ...ops.base(),
        eventType: "merge.failed",
        payload: {
          ...ops.prFields(),
          integration: ops.mergeLabel(),
          message: `merge_state_unknown (reconcile ${disposition.reconcileToken}): ${disposition.reason}`,
        },
      });
      await ops.finalize("conflict", { taskOutcome: "pending", taskStatus: "running" });
      return ops.result("conflict", { message: disposition.reason });
    }
    default: {
      const exhaustive: never = disposition;
      throw new Error(`landViaAuthorityAttempt: unhandled disposition ${String(exhaustive)}`);
    }
  }
}

/** The max native rebase-on-CAS re-drives before a benign race falls back to a recoverable hold. */
const MAX_CAS_REBASE_RETRIES = 2;

/**
 * §3.3 NATIVE REBASE-ON-CAS: a CAS rejection means a batch sibling landed onto main first,
 * so this head's authorized commit is no longer a fast-forward. Rebase the head onto the
 * advanced base through the unified `baseShiftRebase` hook (the SAME never-discard rebase
 * the `behind` path uses), re-gate the rebased tree (anchored on the pushed rebased head —
 * NEVER-MERGE-UNVERIFIED), and re-attempt the land. This replaces the GitHub-`behind`-only
 * rebase trigger that never fired on an unprotected repo. Bounded by `MAX_CAS_REBASE_RETRIES`;
 * an absent base-shift hook / a held rebase / a failed re-gate / the bound all hold
 * RECOVERABLY (the recovery surface re-drives) — never a terminal `merge.conflict` dequeue.
 */
async function rebaseOnCasAndRetry(
  deps: DispatcherDeps,
  ops: LandOps,
  bundle: MergeAuthorityBundle,
  mergeability: PullRequestMergeability,
  casReason: string,
  casRetries: number,
): Promise<MergeForRunResult> {
  const recoverableHold = async (message: string): Promise<MergeForRunResult> => {
    await ops.finalize("blocked", { taskOutcome: "pending", taskStatus: "running" });
    return ops.result("blocked", { message });
  };
  if (casRetries >= MAX_CAS_REBASE_RETRIES) {
    return recoverableHold(
      `land CAS rejected ${casRetries}x (main keeps advancing); holding for re-drive: ${casReason}`,
    );
  }
  if (deps.input.baseShiftRebase === undefined) {
    // No unified base-shift hook wired — cannot rebase natively. HOLD recoverably (the
    // recovery surface re-drives once main settles); never a terminal dequeue.
    return recoverableHold(`land CAS rejected (main advanced); no base-shift hook to rebase — holding: ${casReason}`);
  }
  await deps.eventStore.append({
    ...ops.base(),
    eventType: "merge.behind",
    payload: {
      ...ops.prFields(),
      integration: ops.mergeLabel(),
      baseBranch: mergeability.baseBranch || deps.context.baseBranch,
      headBranch: mergeability.headBranch || undefined,
      mergeableState: "cas_rejected",
    },
  });
  // Rebase the head onto the now-advanced base (never-discard). A real conflict / a held
  // rebase / an up-to-date race all hold recoverably here — the resolver path owns a
  // genuine conflict; this CAS retry never escalates on its own.
  const updated = await rebaseBehindBranch(deps, mergeability);
  if (updated.outcome === "conflict") {
    return recoverableHold(`CAS rebase surfaced a conflict (routing to recovery): ${updated.message ?? casReason}`);
  }
  if (updated.outcome === "held" || updated.outcome === "up_to_date") {
    return recoverableHold(
      `CAS rebase did not advance the head (${updated.outcome}); holding for re-drive: ${casReason}`,
    );
  }
  // The head advanced onto base — its prior gate is stale. Re-gate the PUSHED rebased head
  // (NEVER-MERGE-UNVERIFIED: bind the verdict to the actually-pushed tree), then re-attempt
  // the land. An absent / failing / non-converged re-gate holds recoverably.
  const reGate = deps.input.reGateCi;
  if (reGate === undefined) {
    return recoverableHold(
      "CAS rebase advanced the head but no re-gate hook is wired — holding (cannot verify rebased tree)",
    );
  }
  const ci = await reGate(updated.rebasedHeadSha === undefined ? {} : { rebasedHeadSha: updated.rebasedHeadSha });
  if (ci.status !== "passed") {
    return recoverableHold(`CAS rebase re-gate ${ci.status} on the rebased tree; holding for re-drive`);
  }
  await deps.eventStore.append({
    ...ops.base(),
    eventType: "merge.rebased",
    payload: {
      ...ops.prFields(),
      integration: ops.mergeLabel(),
      baseBranch: mergeability.baseBranch || deps.context.baseBranch,
      headBranch: mergeability.headBranch || undefined,
      reGatedCi: true,
    },
  });
  // REBUILD the authority bundle before the re-attempt: the rebase advanced the head, so
  // the bundle's captured `gatedHeadSha` is now STALE and the authority's commit-binding
  // (gatedHeadSha === landing head) would BLOCK. The re-gate above emitted a FRESH
  // `pre_merge` gate.verdict for the pushed rebased head; rebuilding re-reads it via
  // `resolveLandTimeSignals` so the verdict binds to the actual landing commit
  // (NEVER-MERGE-UNVERIFIED). Absent a rebuild thunk (a pre-supplied bundle / test seam) we
  // reuse the bundle — those callers re-gate against the same head, so it is not stale.
  const rebuilt = deps.input.buildMergeAuthority === undefined ? bundle : await deps.input.buildMergeAuthority();
  return landViaAuthorityAttempt(deps, ops, rebuilt, casRetries + 1);
}

/**
 * Record the posture-gate's residual P2/P3 disposition after a merge (§4). The merge
 * already CLEARED the block decision, so these findings are below `blockReviewAt`; the
 * project posture decides their fate: `route-to-dag` ⇒ each becomes a new DAG spec;
 * `fix-if-idle` ⇒ carried forward (the spec just merged, so it is NOT idle-awaiting-
 * review). The `auditor.findings_routed` event is the durable audit trail of that
 * disposition — the SAME `evaluatePostureGate` policy that drives the block, now wired
 * into the live merge flow. Emitted only when there ARE residual findings.
 */
async function recordPostureRouting(deps: DispatcherDeps, ops: LandOps, bundle: MergeAuthorityBundle): Promise<void> {
  // The land just merged, so the spec is not idle-awaiting-review ⇒ fix-if-idle residuals
  // carry forward rather than spawning mid-run fix work.
  const result = evaluatePostureGate(bundle.findings, bundle.auditPosture, { idleAwaitingReview: false });
  const routed = result.dispositions.filter((d) => d.action === "route").map((d) => refOf(d));
  const fixedInPlace = result.dispositions.filter((d) => d.action === "fix").map((d) => refOf(d));
  const carriedForward = result.dispositions.filter((d) => d.action === "carryForward").map((d) => refOf(d));
  if (routed.length === 0 && fixedInPlace.length === 0 && carriedForward.length === 0) {
    return;
  }
  await deps.eventStore.append({
    ...ops.base(),
    eventType: "auditor.findings_routed",
    payload: {
      runId: deps.context.runId,
      p2p3Handling: bundle.auditPosture.p2p3Handling,
      routed,
      fixedInPlace,
      carriedForward,
    },
  });
}

/** Project a posture disposition's finding onto the routed-finding-ref event shape. */
function refOf(d: { finding: { id: string; severity: string; title: string } }): {
  id: string;
  severity: "P2" | "P3";
  title: string;
} {
  // The posture gate's residuals are below `blockReviewAt` — P2/P3 by construction.
  return { id: d.finding.id, severity: d.finding.severity as "P2" | "P3", title: d.finding.title };
}

/** Emit the authority's fail-closed hold as a `merge.blocked` event (recovery surface). */
async function emitAuthorityBlocked(deps: DispatcherDeps, ops: LandOps, reasons: ReadonlyArray<string>): Promise<void> {
  await deps.eventStore.append({
    ...ops.base(),
    eventType: "merge.blocked",
    payload: {
      ...ops.prFields(),
      integration: deps.integration,
      posture: deps.context.governancePosture,
      mode: "operator_approval",
      externalLogins: [],
      reason: reasons.join("; "),
    },
  });
}

/**
 * Run a FRESH `pre_merge` gate on the RESOLVED tree (§5) before the land authority
 * judges it — so the land authority's gate verdict is a `pre_merge` gate on the EXACT
 * tree being landed (post-resolution), not the stale pre-conflict pre_merge pass. The
 * resolver re-gates with the `pre_audit` tier; the land reads only `pre_merge`, so a
 * fresh `pre_merge` gate MUST run on the resolved tree here. REQUIRED + fail-closed: an
 * ABSENT re-gate hook, a FAILED gate, or a PENDING (non-converged) gate all HOLD
 * (recoverable) — the resolved tree is never landed on an unverified or stale gate.
 * `reGateCi` runs `runNativeMergeGate` (`pre_merge`), emitting a fresh `pre_merge`
 * gate.verdict the land reader (`resolveLandTimeSignals`) then picks up.
 */
export async function reGateResolvedTree(
  deps: DispatcherDeps,
  ops: LandOps,
): Promise<{ kind: "proceed" } | { kind: "halt"; result: MergeForRunResult }> {
  const reGate = deps.input.reGateCi;
  if (reGate === undefined) {
    return {
      kind: "halt",
      result: await ops.emitConflict(
        "resolved-tree pre_merge re-gate hook is absent; cannot verify the resolved tree — land held",
      ),
    };
  }
  const ci = await reGate();
  if (ci.status === "failed") {
    await deps.eventStore.append({
      ...ops.base(),
      eventType: "merge.failed",
      payload: { ...ops.prFields(), integration: ops.mergeLabel(), message: "pre_merge gate failed on resolved tree" },
    });
    await ops.finalize("failed", { taskOutcome: "failed", taskStatus: "failed", failureKind: "merge_failed" });
    return { kind: "halt", result: ops.result("failed", { message: "pre_merge gate failed on resolved tree" }) };
  }
  if (ci.status === "pending") {
    return { kind: "halt", result: await ops.emitConflict("pre_merge gate did not converge on the resolved tree") };
  }
  return { kind: "proceed" };
}
