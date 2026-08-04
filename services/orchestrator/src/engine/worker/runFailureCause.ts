// THE FINE-GRAINED RUN-FAILURE CAUSE + ATTRIBUTION VOCABULARY.
//
// WHY THIS EXISTS (the verified defect it fixes). `RunFailureCode` is a 13-value
// closed vocabulary sized for the PUBLIC timeline: it answers "what broad class
// of thing broke". On a live instance driving a real monorepo for a day, 209 of
// 225 run failures (93%) classified as the catch-all `internal` — because the
// dominant real error classes were simply absent from the classifier's allowlist.
// The convergence detector keys its fixed point on that code (run failures carry
// no `workSignature`, so the code IS the whole signature), so an SSH outage, then
// a missing GitHub credential, then a control-plane 500 — three CATEGORICALLY
// UNRELATED causes — read as ONE repeating state and parked the spec as
// "genuinely stuck (a bug or mis-spec, not a flake)".
//
// That inverts the detector's own stated premise ("A CHANGED signature is
// progress"). The detector is sound; the SIGNATURE was not. So this module adds a
// SECOND, NARROWER axis alongside the code:
//
//   • `RunFailureCause`      — a stable, fine-grained id for WHAT specifically broke.
//   • `RunFailureAttribution`— WHOSE bug it is: tanren's, the target repo's, the
//                              environment's, or not yet knowable.
//   • `RunPrecondition`      — the named, externally-observable condition the run is
//                              blocked on, when there is one.
//
// THE DOCTRINE THIS SERVES (project owner, verbatim): "Halts are not tolerable. If
// tanren is working correctly, a user has budget, and the roadmap is not complete,
// halting means a fundamental failure in tanren." Refined: a halt is a BUG REPORT,
// not a terminal state. It means either a bug in tanren or a bug in the target
// repository; both get fixed. When tanren cannot proceed, it keeps the work live
// and makes the blocking cause LEGIBLE and ATTRIBUTABLE.
//
// THE SECURITY PROPERTY (inherited from `runFailureClassifier.ts` — read its header).
// `cause` and `attribution` are CLOSED VOCABULARIES selected by `error.name` (the
// error CLASS name), exactly like `code`/`stage`/`summary`. They are NEVER derived
// from, and never echo, the error's MESSAGE. A novel secret shape in a message can
// therefore never widen what a public event carries. An unrecognized error falls
// CLOSED to `unclassified` / `unknown`.
//
// ────────────────────────────────────────────────────────────────────────────────
// A WORKED ATTRIBUTION EXAMPLE (why `attribution` is the useful output, and why
// `WorkspaceCommandError` is deliberately `unknown`).
//
// The live instance produced 14 workspace commit failures, several of them a
// `pnpm: not found` at commit time. That single symptom has TWO possible owners:
//
//   • TANREN's side — the workspace command may run without the provisioned
//     toolchain on PATH, so a hook that legitimately expects `pnpm` cannot find
//     it. That is `attribution: "tanren"` and is being fixed separately (the
//     runner mise/PATH work; do NOT duplicate it here).
//   • The TARGET REPO's side — a project hook can be written against assumptions
//     that only hold on a developer laptop (a hard-coded interpreter path, a
//     version manager that is not present in a container). That is
//     `attribution: "target_repo"`.
//
// Both are real bugs. Naming WHICH ONE is the useful output — it routes the fix to
// the right repository instead of parking the spec with an opaque "internal error".
//
// `WorkspaceCommandError` cannot make that call at the classifier: it is the
// CATCH-ALL that `workspace/ssh.ts` throws for ANY SSH command exiting non-zero (a
// blocked rebase, a vanished remote, a failed hook, a missing binary). The class
// name — the only input classification is allowed to key on — does not distinguish
// them. So it is honestly `unknown`, and NARROWING it (by attributing the specific
// failing command, not by parsing its output) is follow-up work owned elsewhere.
// Guessing here would be worse than admitting ignorance: a wrong attribution sends
// the fix to the wrong repo.
// ────────────────────────────────────────────────────────────────────────────────

/**
 * WHOSE bug a run failure is. The halt-is-a-bug-report doctrine's core output:
 * every blocking cause is routed to a fixable owner.
 *
 *   - `tanren`      — a defect in the orchestrator itself (a double-claim, a lost
 *                     org scope, a control-plane write that 500s). Fix tanren.
 *   - `target_repo` — a defect in the repository being driven (its dependency
 *                     install does not work in a clean container, its hooks assume
 *                     a developer laptop). Fix the target repo.
 *   - `environment` — neither codebase is wrong; a provisioned thing is absent or
 *                     unreachable right now (no SSH route to the runner, an
 *                     unseeded credential, a spent provider window). These CLEAR
 *                     on their own, which is why they carry a {@link RunPrecondition}.
 *   - `unknown`     — the error class genuinely does not determine an owner. Fails
 *                     CLOSED here rather than guessing.
 */
export type RunFailureAttribution = "tanren" | "target_repo" | "environment" | "unknown";

/**
 * A NAMED, EXTERNALLY-OBSERVABLE condition a run is blocked on which can later
 * become true WITHOUT the spec changing. This is the fact that makes parking wrong:
 * the work is not stuck, it is WAITING, and the wait ends by itself.
 *
 * Every value here is something an operator (or an automated provisioner) makes
 * true out-of-band — seeding a credential, re-provisioning an SSH key, correcting
 * org config, restoring the control plane. NOTHING about the spec has to change.
 *
 * Carrying one flips the disposition to a `precondition_block` re-drive: the next
 * run's own attempt IS the probe (the same "re-drive is the probe" pattern the
 * window-pause prober already uses — see `usage/pausedRunResumeProber.ts`), and
 * those re-drives are excluded from the convergence history so the wait can never
 * accumulate toward a fixed point.
 */
export type RunPrecondition =
  /** An SSH route to the run's allocated runner. Clears when the key/host/network returns. */
  | "runner_ssh"
  /** A GitHub token credential resolvable at its configured ref. Clears when it is seeded. */
  | "github_credential"
  /** A GitHub App credential (app id + private key) at its configured ref. Clears when seeded. */
  | "github_app_credential"
  /** Any other required credential resolvable for the org. Clears when it is seeded. */
  | "credential"
  /** The org's provider-mode configuration being resolvable. Clears when config is corrected. */
  | "provider_config"
  /** The control-plane write endpoint accepting writes. Clears when the control plane recovers. */
  | "control_plane";

/**
 * The FINE-GRAINED, closed vocabulary of run-failure causes — the narrow axis the
 * convergence detector keys its fixed point on. One id per distinguishable root
 * cause, so two DIFFERENT causes never alias into one repeating state.
 *
 * Every value is a fixed, human-authored identifier. None is derived from an error
 * message. `unclassified` is the fail-closed default for an unrecognized throw.
 */
export type RunFailureCause =
  // --- runner / transport -----------------------------------------------------
  /** The SSH transport to the runner stayed down across the saturated retry backoff. */
  | "runner_ssh_outage"
  /** A runner row already had a LIVE claim; the second claim was refused. */
  | "runner_double_claim"
  // --- credentials ------------------------------------------------------------
  /** A required credential is absent from the secret store. */
  | "credential_missing"
  /** A GitHub token credential ref is configured but resolves to nothing. */
  | "github_credential_missing"
  /** A GitHub App credential ref is configured but resolves to nothing. */
  | "github_app_credential_missing"
  /** Credential resolution lost its org scope — a tanren-side scoping defect. */
  | "credential_org_scope_lost"
  /** The org's provider mode could not be resolved from its configuration. */
  | "provider_mode_unresolved"
  // --- control plane / worker context ----------------------------------------
  /** A control-plane run-state write failed at the transport (endpoint 5xx / unreachable). */
  | "control_plane_write_failed"
  /** The run's org context was not reachable during bootstrap. */
  | "job_org_context_lost"
  /** The run's execution context could not be loaded. */
  | "run_context_unresolvable"
  /** `runs.ancestor_stack` failed its schema parse during context hydration. */
  | "ancestor_stack_malformed"
  // --- workspace --------------------------------------------------------------
  /** Workspace bootstrap failed. */
  | "workspace_bootstrap_failed"
  /** The target repo's dependency install failed in the workspace. */
  | "workspace_deps_install_failed"
  /** A workspace SSH command exited non-zero (the catch-all — see the header example). */
  | "workspace_command_failed"
  /** The dependent-run speculative base assembly failed. */
  | "speculative_assembly_failed"
  // --- agent / answerer -------------------------------------------------------
  /** The agent's provider usage window is spent. */
  | "provider_usage_window_exhausted"
  /** The answerer produced no forward motion and was declared stalled. */
  | "answerer_stalled"
  /** The answerer's structured output failed its schema validation. */
  | "answerer_schema_invalid"
  /** The writer produced no commit ahead of the base this attempt. */
  | "empty_writer_output"
  /** A persisted design contract failed its schema parse. */
  | "design_contract_corrupt"
  /** The design oracle stage was invoked with a misconfigured actor. */
  | "design_oracle_actor_misconfigured"
  /** The design oracle returned a result missing a required observable field. */
  | "design_oracle_result_malformed"
  /** The spec-quality gate could not make a spec valid at a fixed point. */
  | "spec_persistently_invalid"
  // --- planner-loop NON-PASS exits ---------------------------------------------
  // These are not thrown errors — they are the planner loop's own terminal exits. They
  // all shared the `internal` failure code (and therefore ONE convergence signature)
  // before this change, so a spec that stalled, then failed its merge gate, then
  // stalled its review read as the same state three times. Each gets its own cause for
  // the same reason every thrown class does: DIFFERENT problems must not alias.
  /** The planner loop stalled without converging. */
  | "planner_convergence_stalled"
  /** The pre-merge gate was not satisfied within the self-heal budget. */
  | "merge_gate_unsatisfied"
  /** A pre-merge behavior verification failed or could not be proven on the preview. */
  | "pre_merge_behavior_unsatisfied"
  /** The review did not resolve within the poll/rework budget. */
  | "review_stalled"
  /** The run halted without producing a mergeable change. */
  | "run_halted_without_change"
  // --- merge / review publication --------------------------------------------
  /** Strict simulated-review publication failed. */
  | "simulated_review_publication_failed"
  /** Strict simulated-review publication is contended. */
  | "simulated_review_publish_contended"
  /** The pull request advanced before strict simulated-review publication. */
  | "simulated_review_head_stale"
  // --- fail-closed default ----------------------------------------------------
  /** An unrecognized throw. The fail-closed default — never a guess. */
  | "unclassified";

/**
 * The cause vocabulary as a runtime array, so the event schemas that carry `cause`
 * on a payload (`dag.spec.redriven`, `dag.spec.needs_attention`, `run.failed`) build
 * their `z.enum` FROM this one list. The vocabulary can therefore only be widened in
 * one place, and a payload can never carry a cause the classifier cannot produce.
 *
 * The `satisfies` clause makes a divergence between this array and
 * {@link RunFailureCause} a TYPE ERROR at build time, not a runtime surprise.
 */
export const RUN_FAILURE_CAUSES = [
  "runner_ssh_outage",
  "runner_double_claim",
  "credential_missing",
  "github_credential_missing",
  "github_app_credential_missing",
  "credential_org_scope_lost",
  "provider_mode_unresolved",
  "control_plane_write_failed",
  "job_org_context_lost",
  "run_context_unresolvable",
  "ancestor_stack_malformed",
  "workspace_bootstrap_failed",
  "workspace_deps_install_failed",
  "workspace_command_failed",
  "speculative_assembly_failed",
  "provider_usage_window_exhausted",
  "answerer_stalled",
  "answerer_schema_invalid",
  "empty_writer_output",
  "design_contract_corrupt",
  "design_oracle_actor_misconfigured",
  "design_oracle_result_malformed",
  "spec_persistently_invalid",
  "planner_convergence_stalled",
  "merge_gate_unsatisfied",
  "pre_merge_behavior_unsatisfied",
  "review_stalled",
  "run_halted_without_change",
  "simulated_review_publication_failed",
  "simulated_review_publish_contended",
  "simulated_review_head_stale",
  "unclassified",
] as const satisfies readonly RunFailureCause[];

/** The attribution vocabulary as a runtime array (same one-place-widening rule as above). */
export const RUN_FAILURE_ATTRIBUTIONS = [
  "tanren",
  "target_repo",
  "environment",
  "unknown",
] as const satisfies readonly RunFailureAttribution[];

/** The precondition vocabulary as a runtime array (same one-place-widening rule as above). */
export const RUN_PRECONDITIONS = [
  "runner_ssh",
  "github_credential",
  "github_app_credential",
  "credential",
  "provider_config",
  "control_plane",
] as const satisfies readonly RunPrecondition[];

/**
 * Exhaustiveness guard. `satisfies` above pins each ARRAY to its union (no member the union
 * does not have); this pins each UNION to its array (no member the array is missing). If a
 * cause / attribution / precondition is added to a union and not to its runtime list, the
 * tuple slot below collapses to `never` and this assignment stops compiling — so the
 * event schemas built from these arrays can never fall behind the classifier.
 */
type CausesAreTotal = Exclude<RunFailureCause, (typeof RUN_FAILURE_CAUSES)[number]> extends never ? true : never;
type AttributionsAreTotal =
  Exclude<RunFailureAttribution, (typeof RUN_FAILURE_ATTRIBUTIONS)[number]> extends never ? true : never;
type PreconditionsAreTotal = Exclude<RunPrecondition, (typeof RUN_PRECONDITIONS)[number]> extends never ? true : never;
const VOCABULARIES_ARE_TOTAL: [CausesAreTotal, AttributionsAreTotal, PreconditionsAreTotal] = [true, true, true];
void VOCABULARIES_ARE_TOTAL;
