// SP-2 — GENERALIZED F2 AUTHORING KERNEL CONTRACT.
//
// This file is the frozen, implementation-free surface for rv-3, ds-3, in-7,
// bh-19, and gv-10. The kernel owns convergence and persistence ordering; a
// family binding owns all domain meaning. No table, proof digest, proof-reuse
// key, or land decision belongs in this contract.

/** The five family namespaces that consume the generalized kernel. */
export type AuthoringFamilyId = "rv-3" | "ds-3" | "in-7" | "bh-19" | "gv-10";

/** Ephemeral local convergence material; never a proof identity or SP-3 digest. */
export type AuthoringConvergenceSignature = string;

/** The only terminal decision made by the per-spec convergence loop. */
export type AuthoringAttemptDecision = "continue" | "converged" | "halted_fixed_point";

/** The invocation envelope is opaque to the kernel and owned by the binding. */
export interface AuthoringKernelInput<Spec> {
  readonly missing: readonly Spec[];
  readonly context?: unknown;
}

/** A prior draft and its rejection, fed back on the next authoring iteration. */
export interface PreviousAuthoringAttempt<Draft> {
  readonly draft?: Draft;
  readonly rejection: string;
}

/** Input presented to the family writer. A writer may mutate source only. */
export interface AuthoringAuthorerInput<Spec, Draft> {
  readonly request: AuthoringKernelInput<Spec>;
  readonly spec: Spec;
  readonly previousAttempt?: PreviousAuthoringAttempt<Draft>;
}

/** Writer seam. Writer failures are converted into rejection attempts by the kernel. */
export interface AuthoringAuthorer<Spec, Draft> {
  author(input: AuthoringAuthorerInput<Spec, Draft>): Promise<Draft>;
}

/** Validator verdict; validation is read-only and must not mutate family state. */
export type AuthoringValidationVerdict<Validated> =
  | { readonly kind: "valid"; readonly validated: Validated }
  | { readonly kind: "rejected"; readonly rejection: string };

/** Validator seam. It returns a verdict and MUST NOT throw. */
export interface AuthoringValidator<Spec, Draft, Validated> {
  validate(input: {
    readonly request: AuthoringKernelInput<Spec>;
    readonly spec: Spec;
    readonly draft: Draft;
  }): Promise<AuthoringValidationVerdict<Validated>>;
}

/** Atomic family persistence seam; it never names or assumes a table. */
export interface AuthoringPersistence<Spec, Draft, Validated> {
  /** One transaction; the created row is persisted with status `validated`. */
  createValidated(input: {
    readonly request: AuthoringKernelInput<Spec>;
    readonly spec: Spec;
    readonly draft: Draft;
    readonly validated: Validated;
  }): Promise<{ readonly persistedId: string }>;

  /** Retracts a row after a failed or skipped whole-batch compose gate. */
  deleteById(persistedId: string): Promise<void>;
}

/** A newly validated row carried into the post-authoring batch gate. */
export interface PersistedAuthoringEntry<Spec, Validated> {
  readonly spec: Spec;
  readonly validated: Validated;
  readonly persistedId: string;
  readonly attempts: number;
}

/** Result of composing the complete augmented family set. */
export type AuthoringBatchComposeVerdict =
  | { readonly kind: "passed" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "skipped"; readonly reason: string };

/** Whole-set compose seam. The binding composes existing family state plus `authored`. */
export interface AuthoringBatchCompose<Spec, Validated> {
  compose(input: {
    readonly request: AuthoringKernelInput<Spec>;
    readonly authored: readonly PersistedAuthoringEntry<Spec, Validated>[];
  }): Promise<AuthoringBatchComposeVerdict>;
}

/** Binding projections used to form the ephemeral signature and bounded preview. */
export interface AuthoringSignatureDerivation<Draft> {
  /** Canonicalize the draft body; the result is not persisted as an identity. */
  canonicalize(draft: Draft): string;
  /** Remove cosmetic/provider-variable rejection noise before signature comparison. */
  sanitize(rejection: string): string;
  /** Project a draft to event text; the kernel truncates it to 500 characters. */
  preview(draft: Draft): string;
}

// EVENT VOCABULARY OWNERSHIP (SP-8). The kernel does NOT own the event kind
// strings. It knows only the four LIFECYCLE POINTS and the payload each carries.
// The family binding's event factory maps a lifecycle point to the family's OWN
// SP-8-registered event (`designFragment.authoring.*`, `integration.author.*`,
// `verification.author.*`, `policy.author.*`, …) — the kernel never hardcodes
// `${familyId}.authoring.*`. The `Event` type parameter is the family's registered
// union; the kernel treats it opaquely and only pushes it into the sink.

/** The lifecycle point the kernel reached; the payload it hands the factory. */
export type AuthoringLifecyclePoint<Spec, Draft, Validated> =
  | { readonly point: "started"; readonly unitId: string; readonly spec: Spec }
  | {
      readonly point: "attempt";
      readonly unitId: string;
      readonly attempt: number;
      readonly draft?: Draft;
      readonly bodyPreview: string;
      readonly canonicalSignature: AuthoringConvergenceSignature;
      readonly rejection: string;
      readonly decision: AuthoringAttemptDecision;
    }
  | { readonly point: "succeeded"; readonly unitId: string; readonly attempts: number; readonly validated: Validated }
  | { readonly point: "failed"; readonly unitId: string; readonly reason: string; readonly attempts: number };

/** Family factory: maps a kernel lifecycle point to a family-owned SP-8 event.
 * `request` is passed so the factory can stamp org/run/provenance from context. */
export interface AuthoringEventFactory<Spec, Draft, Validated, Event> {
  build(input: {
    readonly request: AuthoringKernelInput<Spec>;
    readonly lifecycle: AuthoringLifecyclePoint<Spec, Draft, Validated>;
  }): Event;
}

/** Throw-safe event sink; an emit failure is log-warned and never escapes the kernel. */
export interface AuthoringEventSink<Event> {
  emit(event: Event): Promise<void>;
}

/** Event factory plus sink, kept separate from persistence and proof concerns. */
export interface AuthoringEvents<Spec, Draft, Validated, Event> {
  readonly factory: AuthoringEventFactory<Spec, Draft, Validated, Event>;
  readonly sink: AuthoringEventSink<Event>;
}

/** Fixed convergence defaults. The ceiling is an integer count, never wall-clock time. */
export interface AuthoringConvergenceConfig {
  readonly signatureWindowSize: number;
  readonly iterationCeiling: number;
}

export const AUTHORING_SIGNATURE_WINDOW_SIZE = 8;
export const AUTHORING_ITERATION_CEILING = 24;
export const AUTHORING_ATTEMPT_BODY_PREVIEW_MAX = 500;
export const DEFAULT_AUTHORING_CONVERGENCE: AuthoringConvergenceConfig = {
  signatureWindowSize: AUTHORING_SIGNATURE_WINDOW_SIZE,
  iterationCeiling: AUTHORING_ITERATION_CEILING,
};

/** Per-family plug for the generalized F2 kernel. `Event` is the family's own
 * SP-8-registered event union; the kernel treats it opaquely. */
export interface AuthoringFamilyBinding<Spec, Draft, Validated, Event> {
  readonly familyId: AuthoringFamilyId;
  readonly unitId: (spec: Spec) => string;
  readonly authorer: AuthoringAuthorer<Spec, Draft>;
  readonly validator: AuthoringValidator<Spec, Draft, Validated>;
  readonly persistence: AuthoringPersistence<Spec, Draft, Validated>;
  readonly batchCompose: AuthoringBatchCompose<Spec, Validated>;
  readonly signatures: AuthoringSignatureDerivation<Draft>;
  readonly events: AuthoringEvents<Spec, Draft, Validated, Event>;
  readonly convergence?: Partial<AuthoringConvergenceConfig>;
}

/** Only committed validated artifacts are returned; retracted artifacts are absent. */
export interface AuthoringKernelResult<Validated> {
  readonly validated: readonly Validated[];
  readonly failedIds: readonly string[];
  readonly failureReasons: Readonly<Record<string, string>>;
}

/**
 * The implementation supplied by SP-2. It processes `missing` sequentially;
 * detects recurrence by membership in the trailing signature window (not by
 * comparing only with the last signature); applies the integer ceiling; persists
 * atomically; defers success until batch `passed`; retracts every persisted entry
 * before batch `failed`/`skipped` failure events; and swallows event-sink throws.
 */
export interface AuthoringKernel<Spec, Draft, Validated, Event> {
  run(
    input: AuthoringKernelInput<Spec>,
    binding: AuthoringFamilyBinding<Spec, Draft, Validated, Event>,
  ): Promise<AuthoringKernelResult<Validated>>;
}

/**
 * Every family binding must conformance-test these adversarial cases: sequential
 * failure isolation; previous-attempt feedback; repeated and alternating signatures;
 * ceiling termination; 500-character previews; validator read-only behavior; atomic
 * persistence failure; deferred success; failed/skipped batch retract-before-failed
 * ordering with real attempt counts; exactly one terminal event per authored unit;
 * throw-safe event emission; and no proof, proof-reuse, or land authority in the kernel.
 */
export type AuthoringKernelConformanceCase =
  | "sequential_failure_isolation"
  | "previous_attempt_feedback"
  | "signature_window_detects_recurrence"
  | "iteration_ceiling_is_integer_bound"
  | "body_preview_is_bounded"
  | "validator_is_non_mutating_and_non_throwing"
  | "persistence_throw_is_failed_and_non_propagating"
  | "success_is_deferred_until_batch_pass"
  | "batch_failure_retracts_before_failed"
  | "batch_skip_retracts_before_failed"
  | "terminal_event_is_exactly_once"
  | "event_emit_throw_is_non_propagating"
  | "kernel_does_not_mint_proof_or_land";
