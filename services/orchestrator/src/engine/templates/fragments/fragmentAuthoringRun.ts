// PER-FRAGMENT AUTHORING DAG (docs/roadmap/templating-system.md — F2).
//
// When `selectFragmentConfig` returns `{ kind: "missing-fragments", missing }`,
// the derive spawns ONE authoring run PER missing fragment. Each authoring run
// produces a validated `Fragment` the org's `fragments` table persists; the
// unified library loader picks it up on the retry.
//
// THE DAG SHAPE per fragment: PLAN (the `FragmentSpec` IS the plan) → WRITE (the
// `FragmentAuthorer` seam iterates on a body; each VALIDATE rejection feeds back
// as `previousAttempt`; the loop halts at a FIXED POINT — the current signature
// APPEARS in the trailing window of recent signatures) → VALIDATE (parse body
// via `interpretOrgFragment`, run BOTH the isolated + full-library smoke
// compositions; pass ⇒ persist as validated ATOMICALLY). On fixed-point failure
// `failedIds` lets `resolveFragmentConfig` halt loud with
// `FragmentAuthoringFailedError` — NEVER silent-skip.
//
// AFTER the sequential per-fragment loop finishes, a POST-AUTHORING BATCH
// COMPOSE re-validates the augmented library against the CAPTURED runtime as a
// single combined compose — catches the cross-fragment `dependency_runtime_mismatch`
// class the per-fragment smokes cannot see (`batchComposeAfterAuthoring.ts`).

import type { ActorContext } from "../../../auth/schemas.js";
import { canonicalizeBodySignature } from "./canonicalizeBody.js";
export { deriveImplicitDependsOn } from "./implicitDependsOn.js";
import { loadFragmentLibrary } from "./library/index.js";
import { drivePostAuthoringOutcome, wrapEventsWithLogging, type AuthoredForBatch } from "./postAuthoringOutcome.js";
import { deriveRuntimeLanguage, unsupportedRuntimeLanguageReason } from "./runtimeLanguage.js";
import type { RuntimeValiditySmokeDeps } from "./runtimeValiditySmoke.js";
import { sanitizeAuthorerErrorSignature } from "./sanitizeAuthorerErrorSignature.js";
import { type FragmentLibrary } from "./types.js";
import type { FragmentSpec } from "./selectFragmentConfig.js";
import { interpretOrgFragment, type OrgFragmentSource } from "./unifiedLibrary.js";
import { validateFragmentBody } from "./validateFragmentBody.js";
import { type CaptureLifecycle } from "../../forge/interview/types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("fragment-authoring");

// ── Public seam ─────────────────────────────────────────────────────────────

// F2 prompt-hardening context types (extracted to keep this file under the 500-line cap).
export type { PriorFragment, ProductContext } from "./fragmentAuthoringContextTypes.js";
import type { PriorFragment, ProductContext } from "./fragmentAuthoringContextTypes.js";

/** Input the derive hands the authoring runner. */
export interface FragmentAuthoringInput {
  orgId: string;
  actor: ActorContext;
  missing: readonly FragmentSpec[];
  lifecycle: CaptureLifecycle;
  /** The current unified library (bundled + prior org fragments). Freshly
   * authored fragments merge into this library so retries and batch compose
   * retain earlier org fragments. */
  library?: FragmentLibrary;
  /** OPTIONAL semi-structured product context. Passed through to each per-fragment
   * writer prompt so the writer can make domain-informed defaults. */
  productContext?: ProductContext;
}

/** What the authoring runner returns to the derive. */
export interface FragmentAuthoringResult {
  /** The augmented library (bundled core + freshly-authored org fragments). */
  library: FragmentLibrary;
  /** Ids the authoring runner could not produce a valid fragment for. */
  failedIds: string[];
  /** Per-fragment-id: the LAST writer rejection captured at the fixed point. */
  failureReasons: Record<string, string>;
}

export type FragmentAuthoring = (input: FragmentAuthoringInput) => Promise<FragmentAuthoringResult>;

/** SIGNATURE PROGRESS WINDOW SIZE.
 *
 * Fix 1 (Codex HIGH #3 — the alternating-body drift class). The prior loop
 * compared each new signature ONLY against the IMMEDIATELY prior signature;
 * an authorer alternating between two rejection classes (`vitest@^99` ↔
 * `vitest@^98`) satisfied "signature != last_signature" every iteration and
 * burned credits unbounded. The window compares against the last N distinct
 * signatures — if the current signature is IN the trailing window, the loop
 * is cycling through a bounded set of failure classes ⇒ fixed point. 8 is
 * large enough to catch 2-4-fragment alternations without being so large that
 * a genuinely-progressing writer trips it. */
export const FRAGMENT_AUTHORING_SIGNATURE_WINDOW = 8;

/** PER-FRAGMENT ITERATION CEILING (arch-allow: timeout-class — integer count,
 * not a wall-clock bound; safety net over the signature-window fixed-point).
 *
 * Fix 1 (safety net over the primary progress bound). The signature window
 * catches alternating drift, but a pathological writer that produces a NEW
 * rejection class on every attempt (say, appending an unbounded counter to a
 * fresh identifier each time) would still slip past the window for a while.
 * The ceiling caps that failure mode at a hard integer count. Signature
 * window ≠ ceiling: the window is progress-based (semantic diversity of
 * rejection classes), the ceiling is a hard integer count. Both bounds serve
 * different failure modes — a genuinely-converging writer never reaches
 * either; a stuck-alternating writer hits the window; a stuck-drifting
 * writer hits the ceiling. Chosen well over the 8-signature window so the
 * primary bound has clear room to fire on legitimate slow convergence. */
export const FRAGMENT_AUTHORING_ITERATION_CEILING = 24;

// ── The single-fragment authoring loop ──────────────────────────────────────

/** What a single `FragmentAuthorer` call sees. */
export interface FragmentAuthorerInput {
  spec: FragmentSpec;
  lifecycle: CaptureLifecycle;
  previousAttempt?: { bodyTs: string; rejection: string };
  priorFragments?: readonly PriorFragment[];
  productContext?: ProductContext;
}

/** What a `FragmentAuthorer` returns. */
export interface FragmentAuthorerOutput {
  bodyTs: string;
}

/** The seam the wiring layer fills — production calls an LLM-backed authorer. */
export type FragmentAuthorer = (input: FragmentAuthorerInput) => Promise<FragmentAuthorerOutput>;

/** The persistence seam — production wires this to `FragmentsStore.createValidated`
 * + `FragmentsStore.deleteById`.
 *
 * ATOMIC by contract (audit finding H2 — task #150): the single `createValidated`
 * call inserts the row with `status='validated'` + `validated_at=now()` in ONE
 * transaction. A throw here rolls back; the F2 loop's Fix-4 try/catch surfaces
 * the throw as a terminal `fragment.authoring.failed` event so the event stream
 * never shows "converged" with no follow-up on a unique-index collision.
 *
 * RETRACT-WITH-DELETE (Round-III H1 — the post-authoring batch compose gate).
 * When the batch compose rejects the augmented library, `deleteById` retracts
 * the persisted row so the org's `fragments` table stays free of cross-run
 * contamination. Prior behavior emitted `failed` without deleting; the org
 * carried the "validated" but broken fragment forward. The delete is
 * best-effort — a throw is log-warn'd in the caller, not propagated. */
export interface FragmentPersistence {
  createValidated(input: {
    orgId: string;
    spec: FragmentSpec;
    bodyTs: string;
    contract: FragmentSpec["requiredContract"];
    dependsOn: readonly string[];
  }): Promise<{ fragmentId: string }>;
  /** Hard-delete a persisted fragment row (Round-III H1 retract). Called by
   * the post-authoring batch-compose retract when the augmented library fails
   * to compose. Non-idempotent-error: deleting an already-absent id succeeds
   * silently (the caller's retract loop is resilient to a row already missing). */
  deleteById(fragmentId: string): Promise<void>;
}

/** Length ceiling for the per-attempt `bodyPreview` field. */
export const FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX = 500;

/** What the writer-rework loop decided after one iteration. */
export type FragmentAuthoringAttemptDecision = "continue" | "converged" | "halted_fixed_point";

/** The event-stream seam — wire to the durable event store so authoring runs are observable. */
export interface FragmentAuthoringEvents {
  emit(
    event:
      | { kind: "fragment.authoring.started"; orgId: string; fragmentId: string; spec: FragmentSpec }
      | {
          kind: "fragment.authoring.attempt";
          orgId: string;
          fragmentId: string;
          attempt: number;
          bodyPreview: string;
          canonicalSignature: string;
          rejection: string;
          decision: FragmentAuthoringAttemptDecision;
        }
      | { kind: "fragment.authoring.succeeded"; orgId: string; fragmentId: string; attempts: number }
      | { kind: "fragment.authoring.failed"; orgId: string; fragmentId: string; reason: string; attempts: number },
  ): Promise<void>;
}

/** Dependencies the runner is built with. */
export interface FragmentAuthoringDeps {
  authorer: FragmentAuthorer;
  persistence: FragmentPersistence;
  events: FragmentAuthoringEvents;
  priorFragmentsLookup?: (orgId: string) => Promise<readonly PriorFragment[]>;
  runtimeValiditySmoke?: RuntimeValiditySmokeDeps;
}

/** Build the authoring runner. The returned function processes the missing list
 * sequentially: an authoring failure on one fragment doesn't stop the others
 * (they may be independent), so the caller sees the full failedIds list at the
 * end rather than the first-failure short-circuit.
 *
 * ROUND-III RESTRUCTURE (H1/H4/H7/M2/M6). The event ordering is coordinated with
 * the post-authoring batch compose:
 *   - `authorOneFragment` NO LONGER emits `fragment.authoring.succeeded` — that
 *     emit is DEFERRED until the batch gate passes. (H4 fix: no succeeded-then-
 *     failed for the same id when batch retract fires.)
 *   - On batch failure/skip, each authored row is DELETED from persistence
 *     BEFORE emitting `failed` — the org's fragments table stays free of
 *     retracted rows. (H1 fix.)
 *   - The retract-emit carries the REAL per-fragment attempts count — no more
 *     hardcoded `attempts: 1`. (H7 fix.)
 *   - Every event emit is try/catch'd so a DB-down `events.emit` cannot
 *     propagate upward and defeat the "continue authoring remaining specs"
 *     contract. (M2 fix.)
 *   - The `skipped` arm is EXPLICITLY treated as a failure — no silent commit.
 *     (M6 fix.) */
export function buildFragmentAuthoring(deps: FragmentAuthoringDeps): FragmentAuthoring {
  // Wrap `deps.events` so every emit call is throw-safe (M2). The per-spec
  // authorOneFragment loop passes this wrapped seam through; the batch-outcome
  // module (postAuthoringOutcome.ts) does its own wrapping since it may be
  // called with a bare seam. Both belt+braces so a future refactor cannot
  // accidentally drop a wrap.
  const safeEvents = wrapEventsWithLogging(deps.events);
  const safeDeps: FragmentAuthoringDeps = { ...deps, events: safeEvents };

  return async (input: FragmentAuthoringInput): Promise<FragmentAuthoringResult> => {
    const failedIds: string[] = [];
    const failureReasons: Record<string, string> = {};
    // Each successfully-authored fragment carries its `attempts` + persisted id
    // (used by the batch-outcome retract for the REAL attempts count + the
    // deleteById call). See `postAuthoringOutcome.ts:AuthoredForBatch`.
    const authored: AuthoredForBatch[] = [];

    let priorFragments: readonly PriorFragment[] = [];
    if (safeDeps.priorFragmentsLookup !== undefined) {
      try {
        priorFragments = await safeDeps.priorFragmentsLookup(input.orgId);
      } catch (err) {
        log.warn("prior fragments lookup threw — proceeding with empty prior context", {
          orgId: input.orgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const spec of input.missing) {
      const outcome = await authorOneFragment({
        spec,
        lifecycle: input.lifecycle,
        orgId: input.orgId,
        deps: safeDeps,
        priorFragments,
        ...(input.productContext === undefined ? {} : { productContext: input.productContext }),
      });
      if (outcome.kind === "ok") {
        authored.push({
          spec,
          source: outcome.source,
          attempts: outcome.attempts,
          persistedFragmentId: outcome.persistedFragmentId,
        });
      } else {
        failedIds.push(spec.id);
        failureReasons[spec.id] = outcome.reason;
      }
    }

    // Assemble the augmented library: the caller's bundled + persisted-org
    // library plus freshly-authored fragments. A new authored id wins over a
    // stale same-id entry, matching the unified-loader shadowing precedence.
    const library = input.library ?? loadFragmentLibrary();
    for (const item of authored) {
      const fragment = interpretOrgFragment(item.source);
      if (library.has(fragment.id)) {
        library.replaceForTests(fragment);
      } else {
        library.register(fragment);
      }
    }

    // Fix 3 / Round-III H1+H4+H7+M6: POST-AUTHORING BATCH COMPOSE — the final gate.
    // The batch-outcome handler emits `succeeded` (batch ok) OR retracts
    // persistence + emits `failed` (batch failed | skipped). See
    // `postAuthoringOutcome.ts` for the invariants.
    const outcome = await drivePostAuthoringOutcome({
      orgId: input.orgId,
      lifecycle: input.lifecycle,
      library,
      authored,
      persistence: safeDeps.persistence,
      events: safeDeps.events,
    });
    for (const id of outcome.retractedIds) {
      failedIds.push(id);
      failureReasons[id] = outcome.retractedReasons[id] ?? "batch_compose_failed";
    }

    return { library, failedIds, failureReasons };
  };
}

/** Truncate a fragment body to the `bodyPreview` ceiling for the per-attempt event. */
export function truncateBodyPreview(body: string): string {
  if (body.length <= FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX) return body;
  return `${body.slice(0, FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX)}…`;
}

interface AuthorOneArgs {
  spec: FragmentSpec;
  lifecycle: CaptureLifecycle;
  orgId: string;
  deps: FragmentAuthoringDeps;
  priorFragments: readonly PriorFragment[];
  productContext?: ProductContext;
}

/** The result the per-spec authoring loop returns to `buildFragmentAuthoring`.
 *
 * ROUND-III H7 fix — the `ok` variant now carries `attempts` (the real per-
 * fragment attempt count at convergence) + `persistedFragmentId` (returned by
 * `FragmentPersistence.createValidated` — the id needed for a batch-retract
 * `deleteById`). Prior shape carried only `source`, so the batch-retract had
 * to hardcode `attempts: 1` on the failed emit and had no id to delete. */
type AuthorOneOutcome =
  | { kind: "ok"; source: OrgFragmentSource; attempts: number; persistedFragmentId: string }
  | { kind: "failed"; reason: string };

async function authorOneFragment(args: AuthorOneArgs): Promise<AuthorOneOutcome> {
  const { spec, lifecycle, orgId, deps, priorFragments, productContext } = args;

  // FAIL-FAST language check (apex v72 fix).
  if (spec.kind === "runtime" && deriveRuntimeLanguage(spec.label) === null) {
    const reason = unsupportedRuntimeLanguageReason(spec.label);
    await deps.events.emit({ kind: "fragment.authoring.failed", orgId, fragmentId: spec.id, reason, attempts: 0 });
    return { kind: "failed", reason };
  }

  await deps.events.emit({ kind: "fragment.authoring.started", orgId, fragmentId: spec.id, spec });

  // FIXED-POINT SIGNATURE with a trailing PROGRESS WINDOW (Fix 1 — Codex HIGH #3).
  // Signature comparison: the current signature APPEARS in the last N signatures
  // ⇒ we are cycling ⇒ fixed point. Larger than 1 so alternating drift is
  // caught. All entries are the SANITIZED authorer-throw signatures (Fix 2 —
  // Claude HIGH #3) — content-variable clock/id noise is stripped before hashing
  // so a stuck LLM provider's cosmetically-different error every attempt no
  // longer counts as progress.
  const signatureWindow: string[] = [];
  let attempt = 0;
  let previousAttempt: { bodyTs: string; rejection: string } | undefined;
  let lastRejection = "";

  for (;;) {
    attempt += 1;

    // ITERATION CEILING (Fix 1 — safety net over the signature-window bound).
    // arch-allow: timeout-class — integer count, not a wall-clock deadline.
    if (attempt > FRAGMENT_AUTHORING_ITERATION_CEILING) {
      const reason = `iteration_ceiling_exceeded: exceeded ${FRAGMENT_AUTHORING_ITERATION_CEILING} attempts without convergence (last rejection: ${lastRejection || "<none>"})`;
      await deps.events.emit({
        kind: "fragment.authoring.failed",
        orgId,
        fragmentId: spec.id,
        reason,
        attempts: attempt - 1,
      });
      return { kind: "failed", reason };
    }

    let output: FragmentAuthorerOutput;
    try {
      output = await deps.authorer({
        spec,
        lifecycle,
        ...(previousAttempt && { previousAttempt }),
        ...(priorFragments.length > 0 ? { priorFragments } : {}),
        ...(productContext === undefined ? {} : { productContext }),
      });
    } catch (err) {
      lastRejection = err instanceof Error ? err.message : String(err);
      log.warn("fragment authorer threw", { fragmentId: spec.id, attempt, error: lastRejection });
      // Fix 2: sanitize the error message BEFORE folding into the signature
      // so cosmetic clock/id noise doesn't defeat the fixed-point detector.
      const signature = `authorer-threw:${sanitizeAuthorerErrorSignature(lastRejection)}`;
      const isFixedPoint = signatureWindow.includes(signature);
      await deps.events.emit({
        kind: "fragment.authoring.attempt",
        orgId,
        fragmentId: spec.id,
        attempt,
        bodyPreview: "",
        canonicalSignature: signature,
        rejection: lastRejection,
        decision: isFixedPoint ? "halted_fixed_point" : "continue",
      });
      if (isFixedPoint) break;
      pushSignature(signatureWindow, signature);
      previousAttempt = { bodyTs: previousAttempt?.bodyTs ?? "", rejection: lastRejection };
      continue;
    }
    const bodyTs = output.bodyTs;

    // VALIDATE.
    const validation = await validateFragmentBody({
      spec,
      bodyTs,
      ...(deps.runtimeValiditySmoke && { runtimeValiditySmoke: deps.runtimeValiditySmoke }),
    });
    const canonicalSignature = canonicalizeBodySignature(bodyTs);
    if (validation.kind === "ok") {
      // Emit the WINNING attempt event BEFORE persist — the timeline reads
      // attempt→succeeded in order. If persist throws (Fix 4), the terminal
      // `failed` event follows so the stream never shows converged with no follow-up.
      await deps.events.emit({
        kind: "fragment.authoring.attempt",
        orgId,
        fragmentId: spec.id,
        attempt,
        bodyPreview: truncateBodyPreview(bodyTs),
        canonicalSignature,
        rejection: "",
        decision: "converged",
      });
      const dependsOn = validation.dependsOn;
      const source: OrgFragmentSource = {
        fragmentId: `${orgId}:${spec.id}:1.0.0`,
        kind: spec.kind,
        label: spec.label,
        version: "1.0.0",
        bodyTs,
        contract: spec.requiredContract,
        dependsOn,
      };
      // Fix 4 (Codex MED #2): wrap the atomic persist in try/catch. A
      // unique-index collision on concurrent authoring for the same
      // (org, kind, label, version) would previously leave the event stream
      // showing "attempt converged" with NO terminal failure event. Now we
      // emit `fragment.authoring.failed` on any persistence throw + surface
      // the throw's message as the failure reason. Do NOT throw upward —
      // the outer loop continues authoring the remaining specs.
      let persistedFragmentId: string;
      try {
        const persisted = await deps.persistence.createValidated({
          orgId,
          spec,
          bodyTs,
          contract: spec.requiredContract,
          dependsOn,
        });
        persistedFragmentId = persisted.fragmentId;
      } catch (err) {
        const reason = `persistence_failed: ${err instanceof Error ? err.message : String(err)}`;
        await deps.events.emit({
          kind: "fragment.authoring.failed",
          orgId,
          fragmentId: spec.id,
          reason,
          attempts: attempt,
        });
        return { kind: "failed", reason };
      }
      // Round-III H4: `fragment.authoring.succeeded` is NO LONGER emitted here.
      // The emit is DEFERRED to `drivePostAuthoringOutcome` once the batch
      // compose gate passes — if the batch gate rejects, we retract + emit
      // `failed` instead. Prior behavior emitted both events for the same id
      // when the batch retract fired; the corruption is closed here.
      return { kind: "ok", source, attempts: attempt, persistedFragmentId };
    }

    lastRejection = validation.reason;
    const signature = `${canonicalSignature}:${lastRejection}`;
    const isFixedPoint = signatureWindow.includes(signature);
    await deps.events.emit({
      kind: "fragment.authoring.attempt",
      orgId,
      fragmentId: spec.id,
      attempt,
      bodyPreview: truncateBodyPreview(bodyTs),
      canonicalSignature,
      rejection: lastRejection,
      decision: isFixedPoint ? "halted_fixed_point" : "continue",
    });
    if (isFixedPoint) break;
    pushSignature(signatureWindow, signature);
    previousAttempt = { bodyTs, rejection: lastRejection };
  }

  await deps.events.emit({
    kind: "fragment.authoring.failed",
    orgId,
    fragmentId: spec.id,
    reason: lastRejection || "authoring did not converge",
    attempts: attempt,
  });
  return { kind: "failed", reason: lastRejection || "no rejection captured" };
}

/** Push a signature onto the trailing window, evicting the oldest entry when
 * the window is at capacity. Kept as a helper so the eviction shape is one-line
 * consistent between the two emit branches (authorer-threw + validation-rejected). */
function pushSignature(window: string[], signature: string): void {
  window.push(signature);
  if (window.length > FRAGMENT_AUTHORING_SIGNATURE_WINDOW) {
    window.shift();
  }
}
