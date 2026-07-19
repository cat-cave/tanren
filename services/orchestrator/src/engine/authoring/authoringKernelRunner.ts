// SP-2 — the generalized F2 AUTHORING KERNEL implementation.
//
// The frozen `authoringKernel.ts` contract reserves the convergence + persistence
// run loop for "SP-2"; this file supplies it. It is the SINGLE shared runner every
// family binding consumes (rv-3, ds-3, in-7, bh-19, gv-10) — the design analog is
// ds-3's `DesignFragmentAuthoring`, mirrored 1:1 from the proven code-fragment F2
// loop (`engine/templates/fragments/fragmentAuthoringRun.ts` +
// `postAuthoringOutcome.ts`) but generalized over the binding's opaque
// `Spec`/`Draft`/`Validated`/`Event` type parameters.
//
// THE LOOP (per the contract docstring, lines 180-192): process `missing`
// SEQUENTIALLY (one failing unit never stops the others); per unit run the
// writer→validate fixed-point loop — detect recurrence by MEMBERSHIP in the
// trailing signature window (not just the last signature), apply the INTEGER
// iteration ceiling (a count, never wall-clock time); persist atomically via
// `createValidated`; DEFER `succeeded` until the whole-batch compose gate passes;
// RETRACT every persisted entry with `deleteById` before emitting `failed` on a
// failed/skipped batch (no cross-run contamination); and swallow every event-sink
// throw (observability is best-effort, never row/gate authority).
//
// The kernel owns ONLY convergence + persistence ORDERING. All domain meaning —
// what a draft is, how it validates, which table it persists to, which SP-8 event
// a lifecycle point maps to — lives in the family binding. The kernel never mints
// a proof, a proof-reuse key, or a land decision.

import {
  type AuthoringConvergenceConfig,
  type AuthoringConvergenceSignature,
  type AuthoringFamilyBinding,
  type AuthoringKernel,
  type AuthoringKernelInput,
  type AuthoringKernelResult,
  type AuthoringLifecyclePoint,
  type PersistedAuthoringEntry,
  type PreviousAuthoringAttempt,
  AUTHORING_ATTEMPT_BODY_PREVIEW_MAX,
  DEFAULT_AUTHORING_CONVERGENCE,
} from "../contracts/authoringKernel.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("authoring-kernel");

/** Outcome of the per-unit convergence loop before the whole-batch gate runs. */
type AuthorOneOutcome<Validated> =
  | { readonly kind: "ok"; readonly validated: Validated; readonly persistedId: string; readonly attempts: number }
  | { readonly kind: "failed"; readonly reason: string; readonly attempts: number };

/** Construct the shared generalized authoring kernel. Stateless + reusable across
 * families; a binding is supplied per `run` call. */
export function createAuthoringKernel<Spec, Draft, Validated, Event>(): AuthoringKernel<Spec, Draft, Validated, Event> {
  return { run };
}

async function run<Spec, Draft, Validated, Event>(
  input: AuthoringKernelInput<Spec>,
  binding: AuthoringFamilyBinding<Spec, Draft, Validated, Event>,
): Promise<AuthoringKernelResult<Validated>> {
  const convergence: AuthoringConvergenceConfig = { ...DEFAULT_AUTHORING_CONVERGENCE, ...binding.convergence };
  const failedIds: string[] = [];
  const failureReasons: Record<string, string> = {};
  const authored: PersistedAuthoringEntry<Spec, Validated>[] = [];

  // SEQUENTIAL isolation: a failing unit is recorded and the loop moves on so the
  // caller sees the FULL failed set, not the first-failure short-circuit.
  for (const spec of input.missing) {
    const unitId = binding.unitId(spec);
    const outcome = await authorOne(input, spec, unitId, binding, convergence);
    if (outcome.kind === "ok") {
      authored.push({
        spec,
        validated: outcome.validated,
        persistedId: outcome.persistedId,
        attempts: outcome.attempts,
      });
    } else {
      failedIds.push(unitId);
      failureReasons[unitId] = outcome.reason;
    }
  }

  const validated = await settleBatch(input, binding, authored, failedIds, failureReasons);
  return { validated, failedIds, failureReasons };
}

/** The single-unit writer→validate fixed-point loop. Mirrors `authorOneFragment`. */
async function authorOne<Spec, Draft, Validated, Event>(
  request: AuthoringKernelInput<Spec>,
  spec: Spec,
  unitId: string,
  binding: AuthoringFamilyBinding<Spec, Draft, Validated, Event>,
  convergence: AuthoringConvergenceConfig,
): Promise<AuthorOneOutcome<Validated>> {
  await emit(binding, request, { point: "started", unitId, spec });

  // The trailing PROGRESS window of recent signatures. A signature already IN the
  // window means the writer is cycling through a bounded set of failure classes
  // (alternating drift) ⇒ fixed point. Membership (not last-only) is the fix for
  // the two-class alternation that satisfies "signature != last" forever.
  const signatureWindow: string[] = [];
  let attempt = 0;
  let previousAttempt: PreviousAuthoringAttempt<Draft> | undefined;
  let lastRejection = "";

  for (;;) {
    attempt += 1;

    // INTEGER iteration ceiling — arch-allow: timeout-class. This is a hard COUNT,
    // not a wall-clock deadline; it is the safety net over the primary
    // signature-window bound for a writer that emits a fresh rejection class every
    // attempt (never repeating, so the window never fires).
    if (attempt > convergence.iterationCeiling) {
      const reason = `iteration_ceiling_exceeded: exceeded ${convergence.iterationCeiling} attempts without convergence (last rejection: ${lastRejection || "<none>"})`;
      await emit(binding, request, { point: "failed", unitId, reason, attempts: attempt - 1 });
      return { kind: "failed", reason, attempts: attempt - 1 };
    }

    let draft: Draft;
    try {
      draft = await binding.authorer.author({
        request,
        spec,
        ...(previousAttempt === undefined ? {} : { previousAttempt }),
      });
    } catch (err) {
      // Writer throw → a rejection attempt. Sanitize before folding into the
      // signature so provider clock/id noise cannot masquerade as progress.
      lastRejection = errorMessage(err);
      const signature: AuthoringConvergenceSignature = `authorer-threw:${binding.signatures.sanitize(lastRejection)}`;
      const isFixedPoint = signatureWindow.includes(signature);
      await emit(binding, request, {
        point: "attempt",
        unitId,
        attempt,
        bodyPreview: "",
        canonicalSignature: signature,
        rejection: lastRejection,
        decision: isFixedPoint ? "halted_fixed_point" : "continue",
      });
      if (isFixedPoint) break;
      pushSignature(signatureWindow, signature, convergence);
      previousAttempt = { rejection: lastRejection };
      continue;
    }

    // Validation is READ-ONLY and MUST NOT throw (contract) — a verdict, never an
    // exception. The canonical signature + bounded preview are binding projections.
    const verdict = await binding.validator.validate({ request, spec, draft });
    const canonicalSignature = binding.signatures.canonicalize(draft);
    const bodyPreview = truncatePreview(binding.signatures.preview(draft));

    if (verdict.kind === "valid") {
      // Emit the WINNING attempt BEFORE persist so the timeline reads
      // attempt→(succeeded|failed) in order.
      await emit(binding, request, {
        point: "attempt",
        unitId,
        attempt,
        draft,
        bodyPreview,
        canonicalSignature,
        rejection: "",
        decision: "converged",
      });
      // ATOMIC persist. A throw here (e.g. a unique-index collision) surfaces as a
      // terminal `failed` so the stream never shows converged with no follow-up —
      // and does NOT propagate (the outer loop keeps authoring remaining units).
      let persistedId: string;
      try {
        const persisted = await binding.persistence.createValidated({
          request,
          spec,
          draft,
          validated: verdict.validated,
        });
        persistedId = persisted.persistedId;
      } catch (err) {
        const reason = `persistence_failed: ${errorMessage(err)}`;
        await emit(binding, request, { point: "failed", unitId, reason, attempts: attempt });
        return { kind: "failed", reason, attempts: attempt };
      }
      // DEFER `succeeded`: it is emitted only when the whole-batch gate passes
      // (`settleBatch`). If that gate rejects, the row is retracted + `failed`
      // emitted instead — never both terminal events for the same unit.
      return { kind: "ok", validated: verdict.validated, persistedId, attempts: attempt };
    }

    lastRejection = verdict.rejection;
    const signature: AuthoringConvergenceSignature = `${canonicalSignature}:${binding.signatures.sanitize(lastRejection)}`;
    const isFixedPoint = signatureWindow.includes(signature);
    await emit(binding, request, {
      point: "attempt",
      unitId,
      attempt,
      draft,
      bodyPreview,
      canonicalSignature,
      rejection: lastRejection,
      decision: isFixedPoint ? "halted_fixed_point" : "continue",
    });
    if (isFixedPoint) break;
    pushSignature(signatureWindow, signature, convergence);
    previousAttempt = { draft, rejection: lastRejection };
  }

  const reason = lastRejection || "authoring did not converge";
  await emit(binding, request, { point: "failed", unitId, reason, attempts: attempt });
  return { kind: "failed", reason, attempts: attempt };
}

/** The post-authoring WHOLE-BATCH compose gate + deferred-success / retract flow.
 * Returns only the COMMITTED validated artifacts (a retracted unit is absent). */
async function settleBatch<Spec, Draft, Validated, Event>(
  request: AuthoringKernelInput<Spec>,
  binding: AuthoringFamilyBinding<Spec, Draft, Validated, Event>,
  authored: readonly PersistedAuthoringEntry<Spec, Validated>[],
  failedIds: string[],
  failureReasons: Record<string, string>,
): Promise<Validated[]> {
  if (authored.length === 0) return [];

  const verdict = await binding.batchCompose.compose({ request, authored });
  if (verdict.kind === "passed") {
    const committed: Validated[] = [];
    for (const entry of authored) {
      await emit(binding, request, {
        point: "succeeded",
        unitId: binding.unitId(entry.spec),
        attempts: entry.attempts,
        validated: entry.validated,
      });
      committed.push(entry.validated);
    }
    return committed;
  }

  // failed | skipped — BOTH are hard failures (a skipped compose could not confirm
  // the augmented set composes; committing on hope is the no-silent-branch
  // violation). Retract every persisted row BEFORE the terminal `failed` so the
  // org's table stays free of cross-run contamination.
  const reason =
    verdict.kind === "failed" ? `batch_compose_failed: ${verdict.reason}` : `batch_compose_skipped: ${verdict.reason}`;
  for (const entry of authored) {
    const unitId = binding.unitId(entry.spec);
    try {
      await binding.persistence.deleteById(entry.persistedId);
    } catch (err) {
      log.warn("authoring kernel retract deleteById threw — persisted row may be stuck; continuing", {
        unitId,
        persistedId: entry.persistedId,
        error: errorMessage(err),
      });
    }
    failedIds.push(unitId);
    failureReasons[unitId] = reason;
    await emit(binding, request, { point: "failed", unitId, reason, attempts: entry.attempts });
  }
  return [];
}

/** Build + emit one lifecycle event THROW-SAFELY: a factory or sink throw is
 * log-warned and swallowed (best-effort observability is never row/gate authority). */
async function emit<Spec, Draft, Validated, Event>(
  binding: AuthoringFamilyBinding<Spec, Draft, Validated, Event>,
  request: AuthoringKernelInput<Spec>,
  lifecycle: AuthoringLifecyclePoint<Spec, Draft, Validated>,
): Promise<void> {
  try {
    const event = binding.events.factory.build({ request, lifecycle });
    await binding.events.sink.emit(event);
  } catch (err) {
    log.warn("authoring kernel event emit failed — swallowing (best-effort observability)", {
      familyId: binding.familyId,
      point: lifecycle.point,
      unitId: lifecycle.unitId,
      error: errorMessage(err),
    });
  }
}

/** Push a signature onto the trailing window, evicting the oldest at capacity. */
function pushSignature(window: string[], signature: string, convergence: AuthoringConvergenceConfig): void {
  window.push(signature);
  if (window.length > convergence.signatureWindowSize) window.shift();
}

/** Truncate a binding-projected preview to the kernel's fixed 500-char ceiling. */
function truncatePreview(preview: string): string {
  if (preview.length <= AUTHORING_ATTEMPT_BODY_PREVIEW_MAX) return preview;
  return `${preview.slice(0, AUTHORING_ATTEMPT_BODY_PREVIEW_MAX)}…`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
