// The `validateEmittedSpecs` stage — workstream 1 of the spec-loop redesign.
//
// Gates spec emission. After any agent emits one or more candidate specs, this
// stage validates each against the four-part spec-quality contract
// (specQuality.ts) via the read-only `SpecQualityAnswerer`. The control flow is the
// CONTRACT of workstream 1:
//
//   - A spec that PASSES is returned for the caller to commit into the DAG.
//   - A spec that FAILS is NOT silently accepted — it is looped back to its
//     emitter with the validator's `revisionGuidance`, UNBOUNDED while the
//     re-authoring is making PROGRESS (the failing-dimension set is changing or
//     shrinking — the convergence model, NOT a fixed round count).
//   - A spec STUCK at a genuine FIXED POINT (the validator keeps rejecting it the
//     IDENTICAL way with no progress across rounds) surfaces LOUD: the stage raises
//     `PersistentlyInvalidSpecError`, which the caller maps to a needs_attention
//     escalation. NEVER a silent pass, and NEVER a fixed `attempt === maxRevisions`.
//
// TIMEOUT-ERADICATION (feedback_no_timeouts_progress_based, BINDING): there is NO
// `maxRevisions` round count. The re-author loop continues UNBOUNDED while the
// validator verdict IMPROVES (a different set of failing dimensions, or fewer of
// them — genuine convergence toward a passing spec) and escalates ONLY at an
// intelligently-detected FIXED POINT (the SAME failing dimensions, same count, no
// progress — a human must decide), via the shared `convergenceDetector`.
//
// The stage does NOT auto-spawn: it gates emission and asks the EMITTER to revise
// (via the injected `reviseSpec` callback). It owns no persistence; the caller
// commits the validated specs and raises the escalation.

import type { SpecQualityAnswer } from "../../answerers/schemas/specQuality.js";
import {
  type AttemptSignature,
  decideConvergence,
  fixedPointRuleJudgment,
} from "../../workflow/convergenceDetector.js";
import type { CandidateSpec, SpecQualityAnswerer } from "./validator.js";

// The emitter's re-author callback: given the failing spec + the validator's
// guidance, produce a revised candidate. This is how the gate loops back to the
// emitter (the issue-triage re-triages, discovery re-classifies, etc.) WITHOUT the
// stage knowing which emitter it is driving. `round` is the 1-based re-author round
// (a diagnostic for the emitter — NOT a budget the stage enforces).
export type ReviseSpec = (input: { spec: CandidateSpec; guidance: string; attempt: number }) => Promise<CandidateSpec>;

export interface ValidateEmittedSpecsInput {
  // The candidate spec(s) the emitter just produced.
  specs: ReadonlyArray<CandidateSpec>;
  validator: SpecQualityAnswerer;
  // The emitter's re-author callback. Omit it to make the gate STRICT with no
  // revision loop — a first-pass failure escalates immediately (used by emitters
  // that cannot cheaply re-author a single spec).
  reviseSpec?: ReviseSpec;
}

export interface ValidatedSpec {
  spec: CandidateSpec;
  answer: SpecQualityAnswer;
  // How many revision rounds it took (0 = passed on first emission).
  revisions: number;
}

export interface ValidateEmittedSpecsResult {
  // The validated, contract-passing specs — safe for the caller to commit.
  specs: ReadonlyArray<ValidatedSpec>;
}

// Raised when a spec is STUCK at a genuine fixed point (the validator keeps
// rejecting it identically with no progress), or when validation/emission threw (an
// unvalidatable spec). The caller maps this to a needs_attention escalation — the
// loud surface, never a silent accept.
export class PersistentlyInvalidSpecError extends Error {
  constructor(
    readonly spec: CandidateSpec,
    // The last validator answer, when one was obtained (absent if validation threw).
    readonly lastAnswer: SpecQualityAnswer | undefined,
    readonly revisions: number,
    cause?: unknown,
  ) {
    const guidance = lastAnswer?.revisionGuidance ?? "(validation failed before a verdict was reached)";
    super(
      `spec "${spec.title}" remained invalid after ${revisions} revision(s); ` +
        `it requires human attention. Last guidance: ${guidance}`,
    );
    this.name = "PersistentlyInvalidSpecError";
    if (cause !== undefined) this.cause = cause;
  }
}

// The four contract dimensions, in a stable order — the failing subset is the
// validator's "what's wrong" identity the convergence detector reasons over.
const SPEC_QUALITY_DIMENSIONS = ["accomplishable", "demoable", "nonTrivial", "legible"] as const;

// Distill a rejecting validator answer into a convergence `AttemptSignature`:
//   - `failureSignature` = the SET of failing dimensions (a CHANGED set is progress —
//     the re-author fixed one concern even if it surfaced another), and
//   - `magnitude` = the COUNT of failing dimensions, which SHRINKS as the spec
//     converges toward passing (fewer concerns ⇒ smaller magnitude ⇒ progress, even
//     when the same dimensions stay flagged but a subset clears).
// So a re-author that changes WHICH dimensions fail, or reduces HOW MANY fail, reads
// as PROGRESS (keep revising, UNBOUNDED); only the identical failing set with no
// reduction is a fixed point a human must look at.
function toAttemptSignature(answer: SpecQualityAnswer): AttemptSignature {
  const failing = SPEC_QUALITY_DIMENSIONS.filter((dim) => !answer[dim].pass);
  return { failureSignature: failing.join(","), magnitude: failing.length };
}

// Is the re-author loop at a genuine NON-CONVERGENCE fixed point — the validator
// keeps rejecting the spec the IDENTICAL way (same failing dimensions) with no
// progress across rounds? Routes the rejection history through the SHARED detector;
// there is no answerer to consult at this point, so `fixedPointRuleJudgment` is the
// principled stand-in (escalates ONLY at a PROVEN dead-end, never on a count). Pure
// wrt the loop — hoisted out so its judge closure captures nothing loop-scoped.
async function atRejectionFixedPoint(
  history: ReadonlyArray<AttemptSignature>,
  specTitle: string,
  answer: SpecQualityAnswer,
): Promise<boolean> {
  const decision = await decideConvergence(history, (h) =>
    fixedPointRuleJudgment(
      h,
      () =>
        `spec "${specTitle}" reached a FIXED POINT — the validator keeps rejecting it the ` +
        `identical way (${answer.overall}: ${answer.revisionGuidance || "no guidance"}) with no ` +
        `progress across re-authoring rounds; a human must clarify or split it`,
    ),
  );
  return decision.decision === "escalate";
}

// Validate one candidate spec, looping back to the emitter UNBOUNDED while the
// validator verdict is IMPROVING (progress), escalating only at a genuine
// non-convergence fixed point. Fail-closed: a thrown validator/emitter call
// escalates as `PersistentlyInvalidSpecError`, never a silent accept.
async function validateOne(
  spec: CandidateSpec,
  validator: SpecQualityAnswerer,
  reviseSpec: ReviseSpec | undefined,
): Promise<ValidatedSpec> {
  let current = spec;
  let lastAnswer: SpecQualityAnswer | undefined;
  // The oldest→newest rejection signatures the convergence detector reasons over.
  // round 0 is the first validation of the emitted spec; round N follows N revisions.
  const history: AttemptSignature[] = [];
  // Unbounded: the loop terminates on a pass, a genuine fixed point, or a throw —
  // NEVER on a round count.
  for (let round = 0; ; round += 1) {
    let answer: SpecQualityAnswer;
    try {
      answer = await validator.validate(current);
    } catch (error) {
      // A malformed/unvalidatable answer is LOUD — escalate, never default to pass.
      throw new PersistentlyInvalidSpecError(current, lastAnswer, round, error);
    }
    lastAnswer = answer;
    if (answer.overall === "pass") {
      return { spec: current, answer, revisions: round };
    }
    // Failed. Without an emitter re-author callback there is no loopback — escalate
    // loud immediately (the strict-gate case).
    if (reviseSpec === undefined) {
      throw new PersistentlyInvalidSpecError(current, answer, round);
    }
    // Record this rejection and ask the shared detector whether the re-author loop is
    // CONVERGING (a changed/shrinking failing set → keep revising) or at a genuine
    // FIXED POINT (the identical failing set with no progress → escalate loud).
    history.push(toAttemptSignature(answer));
    if (await atRejectionFixedPoint(history, current.title, answer)) {
      throw new PersistentlyInvalidSpecError(current, answer, round);
    }
    try {
      current = await reviseSpec({ spec: current, guidance: answer.revisionGuidance, attempt: round + 1 });
    } catch (error) {
      throw new PersistentlyInvalidSpecError(current, answer, round, error);
    }
  }
}

/**
 * Gate spec emission: validate every candidate spec against the spec-quality
 * contract, looping each back to its emitter UNBOUNDED while the validator verdict
 * IMPROVES. Returns the validated, contract-passing specs for the caller to commit.
 * Raises `PersistentlyInvalidSpecError` (the loud needs_attention surface) for any
 * spec stuck at a genuine fixed point — never silently accepts a bad spec, and never
 * gives up on a fixed round count.
 */
export async function validateEmittedSpecs(input: ValidateEmittedSpecsInput): Promise<ValidateEmittedSpecsResult> {
  const validated: ValidatedSpec[] = [];
  for (const spec of input.specs) {
    validated.push(await validateOne(spec, input.validator, input.reviseSpec));
  }
  return { specs: validated };
}
