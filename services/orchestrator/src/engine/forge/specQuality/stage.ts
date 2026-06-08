// The `validateEmittedSpecs` stage — workstream 1 of the spec-loop redesign.
//
// Gates spec emission. After any agent emits one or more candidate specs, this
// stage validates each against the four-part spec-quality contract
// (specQuality.ts) via the read-only `SpecQualityAnswerer`. The control flow is the
// CONTRACT of workstream 1:
//
//   - A spec that PASSES is returned for the caller to commit into the DAG.
//   - A spec that FAILS is NOT silently accepted — it is looped back to its
//     emitter with the validator's `revisionGuidance`, BOUNDED by `maxRevisions`.
//   - A spec that is STILL invalid after the bound (or whose validation/emission
//     throws) surfaces LOUD: the stage raises `PersistentlyInvalidSpecError`, which
//     the caller maps to a needs_attention escalation. NEVER a silent pass.
//
// The stage does NOT auto-spawn: it gates emission and asks the EMITTER to revise
// (via the injected `reviseSpec` callback). It owns no persistence; the caller
// commits the validated specs and raises the escalation.

import type { SpecQualityAnswer } from "../../answerers/schemas/specQuality.js";
import type { CandidateSpec, SpecQualityAnswerer } from "./validator.js";

// The emitter's re-author callback: given the failing spec + the validator's
// guidance, produce a revised candidate. This is how the gate loops back to the
// emitter (the issue-triage re-triages, discovery re-classifies, etc.) WITHOUT the
// stage knowing which emitter it is driving.
export type ReviseSpec = (input: { spec: CandidateSpec; guidance: string; attempt: number }) => Promise<CandidateSpec>;

export interface ValidateEmittedSpecsInput {
  // The candidate spec(s) the emitter just produced.
  specs: ReadonlyArray<CandidateSpec>;
  validator: SpecQualityAnswerer;
  // The emitter's re-author callback. Omit it to make the gate STRICT with no
  // revision loop — a first-pass failure escalates immediately (used by emitters
  // that cannot cheaply re-author a single spec).
  reviseSpec?: ReviseSpec;
  // Max revision rounds per spec before the spec is declared persistently invalid
  // and escalated. Defaults to 2 (one emit + two revises). A revision budget, NOT
  // a retry/timeout halt — exhausting it is a genuine "the emitter cannot produce a
  // valid spec" signal a human must act on.
  maxRevisions?: number;
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

// Raised when a spec cannot be made contract-compliant within the revision budget,
// or when validation/emission threw (an unvalidatable spec). The caller maps this
// to a needs_attention escalation — the loud surface, never a silent accept.
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

// Validate one candidate spec, looping back to the emitter (bounded) until it
// passes or the budget is exhausted. Fail-closed: a thrown validator/emitter call
// escalates as `PersistentlyInvalidSpecError`, never a silent accept.
async function validateOne(
  spec: CandidateSpec,
  validator: SpecQualityAnswerer,
  reviseSpec: ReviseSpec | undefined,
  maxRevisions: number,
): Promise<ValidatedSpec> {
  let current = spec;
  let lastAnswer: SpecQualityAnswer | undefined;
  // attempt 0 is the first validation of the emitted spec; attempts 1..maxRevisions
  // each follow a revision. The loop runs maxRevisions+1 validations at most.
  for (let attempt = 0; attempt <= maxRevisions; attempt++) {
    let answer: SpecQualityAnswer;
    try {
      answer = await validator.validate(current);
    } catch (error) {
      // A malformed/unvalidatable answer is LOUD — escalate, never default to pass.
      throw new PersistentlyInvalidSpecError(current, lastAnswer, attempt, error);
    }
    lastAnswer = answer;
    if (answer.overall === "pass") {
      return { spec: current, answer, revisions: attempt };
    }
    // Failed. Without an emitter re-author callback, or once the budget is spent,
    // there is no further loopback — escalate loud.
    if (reviseSpec === undefined || attempt === maxRevisions) {
      throw new PersistentlyInvalidSpecError(current, answer, attempt);
    }
    try {
      current = await reviseSpec({ spec: current, guidance: answer.revisionGuidance, attempt: attempt + 1 });
    } catch (error) {
      throw new PersistentlyInvalidSpecError(current, answer, attempt, error);
    }
  }
  // Unreachable (the loop returns or throws each iteration); satisfies the checker.
  throw new PersistentlyInvalidSpecError(current, lastAnswer, maxRevisions);
}

/**
 * Gate spec emission: validate every candidate spec against the spec-quality
 * contract, looping each back to its emitter (bounded) when it fails. Returns the
 * validated, contract-passing specs for the caller to commit. Raises
 * `PersistentlyInvalidSpecError` (the loud needs_attention surface) for any spec
 * that cannot be made compliant — never silently accepts a bad spec.
 */
export async function validateEmittedSpecs(input: ValidateEmittedSpecsInput): Promise<ValidateEmittedSpecsResult> {
  const maxRevisions = input.maxRevisions ?? 2;
  const validated: ValidatedSpec[] = [];
  for (const spec of input.specs) {
    validated.push(await validateOne(spec, input.validator, input.reviseSpec, maxRevisions));
  }
  return { specs: validated };
}
