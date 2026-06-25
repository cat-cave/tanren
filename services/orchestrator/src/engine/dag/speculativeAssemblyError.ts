// SPECULATIVE-ASSEMBLY ERROR CLASS (apex v56 #61).
//
// The dependent SPECULATIVE-run base-assembly path (jj-local bootstrap +
// integration over the run's allocated runner) used to throw a bare `new Error(...)`
// for every fail-closed branch (missing ancestor branch, conflict at bootstrap,
// phantom workspace handle, unattributable identity, unresolved head/tree shas).
// The worker's `runFailureClassifier` keys off `error.name`, so every one of those
// fell to the catch-all `internal @ run: the run failed with an internal error` —
// the operator could see WHEN the run died (between `runner.allocated` and
// `task.started`, no planner/writer events) but had NO actionable CLASS to triage
// on, and the convergence detector hashed every distinct fault to the same generic
// signature (`internal`), so two distinct assembly faults still escalated as the
// same fixed point.
//
// `SpeculativeAssemblyError` is a single structured class for ALL throws on the
// speculative-assembly path. The `phase` discriminator names the specific step
// (missing ref / bootstrap conflict / phantom workspace / identity / sha resolve)
// so internal triage + a future per-phase event is straightforward; the classifier
// maps the CLASS to a stable public `speculative_assembly` failure code (NOT
// `internal`), so the operator sees a real class on `dag.spec.needs_attention`.
//
// FAIL-CLOSED: this stays a generic-but-structured class — speculative assembly
// over unmerged-ancestor PR heads is a RETRIABLE / TRANSIENT class (an ancestor
// finishing or a runner re-allocation changes the outcome), so the authority
// re-drives it; the consecutive-same-failure cap genuine-halts a persistent one
// LOUDLY as `speculative_assembly` (never the muddled `internal`).

/**
 * The specific assembly step a throw originated from. `phase` is captured for
 * INTERNAL triage (logs + diagnostics); the public classifier reads only the error
 * CLASS NAME, so a novel phase value can never widen what reaches the public event.
 */
export type SpeculativeAssemblyPhase =
  // A member's `<branch>@origin` ref is GONE and it did NOT merge into the base,
  // AND its spec is TERMINAL (or its phase is unknown) — a genuinely missing ancestor branch
  // we refuse to silently drop. (Non-terminal phases throw `AncestorNotReadyError` — a benign
  // wait — and never reach this class.)
  | "missing_ancestor_ref"
  // The clean assembly succeeded but `integrateOverWorkspace` did not surface the open
  // workspace handle the run branch attaches to — an invariant breach the bootstrap refuses
  // to mask (a run branch is never created against a phantom workspace).
  | "phantom_workspace"
  // The bootstrap surfaced a `conflict` outcome at this late point. The walker is supposed
  // to HOLD a dependent whose stack conflicts BEFORE bootstrap (§2.1.4); a conflict here is
  // a real fault, not a silent degrade.
  | "bootstrap_conflict"
  // An AUTHENTICATED clone resolved a token but NO bot identity — a `resolveCloneCredential`
  // contract breach. The bootstrap refuses to author the assembled run branch as the
  // unattributable `tanren@local` default (would block the PR as `<unknown>` external).
  | "missing_clone_identity"
  // A jj revision (a bookmark / the assembled head) did not resolve a 40-hex sha.
  | "head_sha_unresolved"
  // The integrated head did not resolve a git tree hash (the materialized node's content id).
  | "tree_hash_unresolved";

/**
 * A structured failure on the speculative-assembly path (dependent-run base bootstrap +
 * jj-local integration). Carries a `phase` discriminator for internal triage; the
 * public classifier keys off the CLASS NAME (`SpeculativeAssemblyError`), so the public
 * `run.failed` / `dag.spec.needs_attention` event surfaces a specific
 * `speculative_assembly` code instead of the catch-all `internal` — and the convergence
 * detector hashes this class as its own signature so a real fix-point escalates LOUDLY
 * by class, not muddled with every other unknown throw.
 */
export class SpeculativeAssemblyError extends Error {
  constructor(
    readonly phase: SpeculativeAssemblyPhase,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SpeculativeAssemblyError";
  }
}
