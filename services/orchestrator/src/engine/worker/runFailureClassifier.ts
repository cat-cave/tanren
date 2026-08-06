// Public-error-leak hardening (code-integrity finding): the worker-level run
// catch in `runExecutor.ts` wraps the ENTIRE run, so an arbitrary thrown error
// can carry a URL, a repo ref, a command fragment, a provider response, or
// secret-adjacent text. That raw string MUST NOT flow into the PUBLIC
// `run.failed.message` event payload (sensitivityRules marks it `public`).
//
// So the worker classifies the caught error into a STABLE failure CODE + the
// STAGE it failed in + a fixed SAFE summary — all drawn from a closed vocabulary
// (never the error's own message). The public `run.failed` event carries only the
// code/stage/summary; the raw detail goes to the INTERNAL `job_queue.failure_message`
// column (outside RLS) and a redacted log line — never the public event payload.
//
// Classification keys off `error.name` (the error CLASS name) rather than the
// message, so a novel secret shape in the message can never widen what's public.
// An unrecognized error falls CLOSED to the generic `internal` code with a fixed
// summary — never a pass-through of the raw string.

import type { RunFailureAttribution, RunFailureCause, RunPrecondition } from "./runFailureCause.js";

// Re-exported so the many existing import sites of this module pick up the new
// vocabulary without a second import (several files sit at their dependency cap).
export type { RunFailureAttribution, RunFailureCause, RunPrecondition };

/** Closed vocabulary of run-failure codes surfaced on the public timeline. */
export type RunFailureCode =
  | "workspace"
  | "credential"
  | "usage_limit"
  | "merge"
  | "deploy"
  | "empty_writer_output"
  // apex v56 #61: a fail-closed throw on the dependent-run base-assembly path (jj-local
  // bootstrap + integration over the run's allocated runner — missing ancestor ref /
  // bootstrap conflict / phantom workspace / unattributable identity / unresolved
  // head-or-tree sha). Distinguishes from the catch-all `internal` so the operator sees a
  // SPECIFIC actionable class on `dag.spec.needs_attention` instead of the muddled internal
  // error (apex v56 stranded with no actionable class), and so the convergence detector keys
  // a real fix-point on this class — not every unknown throw aliased together.
  | "speculative_assembly"
  // Codex round-3 #3: worker-context-hydration + design-stage pre-row throws (PRs #740,
  // #745) that fall to `classifyRunFailure` BEFORE the stage-level finalize guard can
  // see them. Without a worker-level arm they aliased into the opaque `internal` code
  // on `run.failed`, hiding the typed diagnosis the stage-level classifier already
  // captures (`stageFailureKind.ts`). Each error class here has a MIRROR arm in the
  // stage-level classifier — the two paths agree on WHAT failed regardless of whether
  // the throw landed inside or outside the stage-body guard.
  //
  // - `malformed_ancestor_stack` — `runs.ancestor_stack` jsonb failed the schema parse
  //   during `loadRunContextScoped` context hydration; the resolver fails closed rather
  //   than silently downgrading a speculative run to non-speculative.
  // - `design_contract_corrupt` — a `design_contracts` HEAD row failed
  //   `parseDesignContract`; distinct from ABSENT so a caller can tell "no design phase
  //   yet" apart from "the persisted contract is malformed and must not be used".
  // - `design_oracle_actor_config` — the design oracle stage was invoked with a
  //   null-org actor (thrown BEFORE any store read / task row insert, so the
  //   stage-level guard never sees it).
  // - `malformed_design_oracle_result` — the oracle answerer returned `hasContract:true`
  //   but a required timeline-observable field was missing/empty (this ALSO has a
  //   stage-level arm because it can throw INSIDE the finalize guard, but the worker-level
  //   arm keeps the vocabulary complete for defense in depth).
  | "malformed_ancestor_stack"
  | "design_contract_corrupt"
  | "design_oracle_actor_config"
  | "malformed_design_oracle_result"
  // apex v82: a spec the spec-quality gate could not make valid at a genuine fixed
  // point (`PersistentlyInvalidSpecError`). Under autonomy:auto the triage stage now
  // DROPS + PARKS a triage-PROPOSED invalid spec (loopFindings `gateTriagedSpecs`) so
  // this should NOT reach the run-level catch on that path; this arm is
  // DEFENSE-IN-DEPTH for a genuinely-unfixable spec that escapes by another route — it
  // surfaces a SPECIFIC needs_attention class instead of the opaque `internal` code
  // (which sank the whole apex v82 run behind a muddled `run.failed{internal}`).
  | "spec_persistently_invalid"
  | "internal";

/** Closed vocabulary of the run STAGE a failure is attributed to. */
export type RunFailureStage = "bootstrap" | "credentials" | "workspace" | "agent" | "merge" | "deploy" | "run";

export interface ClassifiedRunFailure {
  /** Stable failure code from the closed enum — safe for a public event payload. */
  code: RunFailureCode;
  /** The run stage the failure is attributed to — safe for a public event payload. */
  stage: RunFailureStage;
  /** A FIXED safe summary (never the raw error string) — safe for a public event payload. */
  summary: string;
  /**
   * The FINE-GRAINED cause id (a second, NARROWER axis alongside `code`) — safe for a
   * public event payload. `code` is the broad public class and is UNCHANGED by design
   * (it is timeline contract and other code branches on it); `cause` is what the
   * convergence detector keys its fixed point on, so two categorically different
   * failures never alias into one repeating state. See `runFailureCause.ts`.
   */
  cause: RunFailureCause;
  /** WHOSE bug this is (tanren / target repo / environment / unknown) — closed vocabulary. */
  attribution: RunFailureAttribution;
  /**
   * Set ONLY when the failure is blocked on a NAMED, externally-observable condition
   * that can later become true WITHOUT the spec changing. Its presence flips the
   * disposition to an indefinite `precondition_block` re-drive instead of a park.
   */
  precondition?: RunPrecondition;
}

// error.name → (code, stage, summary, cause, attribution, precondition?). Keyed by the
// error CLASS name (stable), NOT the message. Every entry's summary is a fixed,
// human-authored, secret-free sentence — the operator/monitor sees WHAT failed + WHERE,
// never the raw detail. `cause` / `attribution` / `precondition` are likewise closed
// vocabularies selected by the class name; none is ever derived from the error text.
//
// The vocabulary is TOTAL: every entry carries a cause + an attribution, and the
// fail-closed default carries `unclassified` / `unknown`.
const BY_ERROR_NAME: Readonly<Record<string, ClassifiedRunFailure>> = {
  WorkspaceBootstrapError: {
    code: "workspace",
    stage: "workspace",
    summary: "workspace bootstrap failed",
    cause: "workspace_bootstrap_failed",
    // Bootstrap spans tanren's provisioning AND the repo's own shape (a clone that
    // needs LFS, a submodule that 404s). The class name does not separate them.
    attribution: "unknown",
  },
  WorkspaceDepsInstallError: {
    code: "workspace",
    stage: "workspace",
    summary: "workspace dependency install failed",
    cause: "workspace_deps_install_failed",
    // The target repo's own dependency graph failed to install in a clean container —
    // a repo-side reproducibility defect, and one the repo can fix.
    attribution: "target_repo",
  },
  MissingCredentialError: {
    code: "credential",
    stage: "credentials",
    summary: "a required credential is missing",
    cause: "credential_missing",
    attribution: "environment",
    // Seeding the credential makes this true without touching the spec.
    precondition: "credential",
  },
  UnscopedOrgError: {
    code: "credential",
    stage: "credentials",
    summary: "credential resolution lost its org scope",
    cause: "credential_org_scope_lost",
    // A tanren-side scoping defect: the resolver was reached without the tenant scope
    // it requires. Nothing external becomes true to fix this — no precondition, so it
    // remains a GENUINE terminal (see `GENUINE_TERMINAL_CODES` in runFinalizeAuthority).
    attribution: "tanren",
  },
  OrgProviderModeUnresolved: {
    code: "credential",
    stage: "credentials",
    summary: "the org's provider mode could not be resolved",
    cause: "provider_mode_unresolved",
    attribution: "environment",
    precondition: "provider_config",
  },
  CodexUsageLimitError: {
    code: "usage_limit",
    stage: "agent",
    summary: "the agent hit its provider usage limit",
    cause: "provider_usage_window_exhausted",
    // Capacity always returns; the window-pause prober owns the resume (task #82),
    // so this routes to `pause_for_capacity` upstream and needs no precondition.
    attribution: "environment",
  },
  // Sibling of `CodexUsageLimitError` for the Claude answerer path. It was ABSENT from
  // this allowlist, so a Claude window exhaustion fell to the `internal` default and
  // was re-driven as a fault instead of routed to the window-pause bucket — the same
  // omission class that produced the live 93%-`internal` reading.
  ClaudeUsageLimitError: {
    code: "usage_limit",
    stage: "agent",
    summary: "the agent hit its provider usage limit",
    cause: "provider_usage_window_exhausted",
    attribution: "environment",
  },
  // The typed transient every answerer-call consumer raises when a call produced no
  // forward motion (`providers/answererSchemaError.ts`). A degraded provider, not a
  // defect in either codebase — it re-drives on the normal convergence path.
  AnswererStalledError: {
    code: "internal",
    stage: "agent",
    summary: "the agent produced no forward motion this attempt",
    cause: "answerer_stalled",
    attribution: "environment",
  },
  // The answerer returned output that failed its structured-output schema. Could be a
  // provider regression or a tanren-side schema the model cannot satisfy — the class
  // name does not say which, so it fails closed to `unknown`.
  AnswererSchemaValidationError: {
    code: "internal",
    stage: "agent",
    summary: "the agent's structured output failed schema validation",
    cause: "answerer_schema_invalid",
    attribution: "unknown",
  },
  JobOrgContextLostError: {
    code: "internal",
    stage: "bootstrap",
    summary: "the run's org context was not reachable",
    cause: "job_org_context_lost",
    attribution: "tanren",
  },
  RunExecutionContextNotFoundError: {
    code: "internal",
    stage: "bootstrap",
    summary: "the run's execution context could not be loaded",
    cause: "run_context_unresolvable",
    attribution: "tanren",
  },
  // The SSH transport to the run's allocated runner stayed down across the SATURATED
  // retry backoff (`ssh/transientRetry.ts`). This was the single largest live failure
  // class — ~122 of 225 failures — and every one of them landed on the opaque
  // `internal` default. It is neither codebase's bug: the route (key, host, network)
  // is absent right now and RETURNS on its own, which is exactly what a precondition
  // names. `workspace` is the honest broad code (the runner IS the workspace
  // transport); `runner_ssh_outage` carries the precision.
  PersistentSshOutageError: {
    code: "workspace",
    stage: "workspace",
    summary: "the SSH route to the run's runner stayed unavailable across the retry backoff",
    cause: "runner_ssh_outage",
    attribution: "environment",
    precondition: "runner_ssh",
  },
  // A GitHub token credential ref IS configured but the secret store has nothing at it
  // (`credentials/githubTokenResolver.ts`). 49 live failures, all read as `internal`.
  // Seeding the secret clears it with no spec change.
  MissingGithubCredentialRefError: {
    code: "credential",
    stage: "credentials",
    summary: "the configured GitHub credential ref resolves to no secret",
    cause: "github_credential_missing",
    attribution: "environment",
    precondition: "github_credential",
  },
  // The GitHub App sibling (`credentials/githubApp.ts`). 20 live failures — and until
  // this change they were thrown as a BARE `Error`, so they could not be classified at
  // all. See the class definition for why it now mirrors the token resolver's shape.
  MissingGithubAppCredentialRefError: {
    code: "credential",
    stage: "credentials",
    summary: "the configured GitHub App credential ref resolves to no secret",
    cause: "github_app_credential_missing",
    attribution: "environment",
    precondition: "github_app_credential",
  },
  // The control-plane run-state write endpoint failed at the TRANSPORT (a 500, an
  // unreachable host) — `worker/httpRunStateWriter.ts`. That is tanren's own control
  // plane misbehaving, so the attribution is `tanren`; but the run is nonetheless
  // BLOCKED on an external condition (the endpoint accepting writes again) that clears
  // without the spec changing, so it also carries a precondition. Attribution answers
  // "who fixes the bug"; precondition answers "may this park" — they are independent.
  RunStateWriteTransportError: {
    code: "internal",
    stage: "run",
    summary: "a control-plane run-state write failed at the transport",
    cause: "control_plane_write_failed",
    attribution: "tanren",
    precondition: "control_plane",
  },
  // A runner row already carried a LIVE claim and the second claim was refused
  // (`allocators/runnerStore.ts`). A tanren-side lifecycle defect — two claimants for
  // one runner. Nothing external becomes true; it re-drives on the normal convergence
  // path and escalates as a genuine bug if it truly repeats.
  RunnerClaimLiveRowError: {
    code: "internal",
    stage: "bootstrap",
    summary: "the run's runner already carried a live claim",
    cause: "runner_double_claim",
    attribution: "tanren",
  },
  // The writer produced NO commit ahead of the base this attempt (GitHub rejected the PR
  // open with "No commits between base and head", and the pushed head equals the run base).
  // A TRANSIENT (a degraded/slow codex returning nothing), NOT a hard internal error — it
  // RE-DRIVES under the consecutive-same-failure cap (a spec that genuinely can never
  // commit after K escalates LOUD as `persistent_failure`, never a silent stall/hot-loop).
  EmptyWriterCommitError: {
    code: "empty_writer_output",
    stage: "agent",
    summary: "the writer produced no commit ahead of the base this attempt",
    cause: "empty_writer_output",
    // A degraded/slow agent returning nothing, or a spec whose change is genuinely
    // already present in the repo. The class name does not separate the two.
    attribution: "unknown",
  },
  // apex v56 #61: every fail-closed throw on the dependent-run speculative base-assembly
  // path normalizes to this CLASS (the `phase` discriminator stays internal-only for log
  // triage). The summary is the same fixed safe sentence regardless of phase — the public
  // event surfaces WHAT failed (the assembly), and the operator pulls the per-phase detail
  // from the INTERNAL `job_queue.failure_message` + the redacted log line.
  SpeculativeAssemblyError: {
    code: "speculative_assembly",
    stage: "workspace",
    summary: "the dependent run's speculative base assembly failed",
    cause: "speculative_assembly_failed",
    // The dependent-run base assembly is entirely tanren's machinery.
    attribution: "tanren",
  },
  // apex v65: `WorkspaceCommandError` is the catch-all thrown by `workspace/ssh.ts` for
  // any SSH command that exits non-zero (a `git rebase` blocked by an unstaged-change tree,
  // a `git fetch` with a vanished remote, etc.). Aliasing all such failures under the
  // generic `internal` code hid the v65 `prepareCleanPrBranch` root cause behind an opaque
  // `run.failed { failureCode: "internal" }` with no underlying error event on the public
  // timeline, AND aliased it together with every unrelated workspace failure in the
  // convergence detector. Pulling it into the "workspace" class — same shape as the v56 #61
  // `SpeculativeAssemblyError` entry above — gives operators a SPECIFIC actionable category
  // on `dag.spec.needs_attention` and lets the convergence detector key a real fix-point on
  // the workspace class, not every unknown throw aliased together.
  WorkspaceCommandError: {
    code: "workspace",
    stage: "workspace",
    summary: "a workspace command failed during the run",
    cause: "workspace_command_failed",
    // DELIBERATELY `unknown`. This is the catch-all for ANY SSH command exiting
    // non-zero, so the class name cannot say whether the fault is tanren's (the
    // command ran without the environment it needs) or the target repo's (the
    // command itself is broken in a clean container). The worked example in
    // `runFailureCause.ts` walks a real live instance of exactly this ambiguity.
    // Narrowing it — by attributing the specific failing command, never by parsing
    // its output — is follow-up work owned elsewhere; guessing here would route
    // fixes to the wrong repository.
    attribution: "unknown",
  },
  // Codex round-3 #3: PR #740 + #745 typed errors that can throw from context-hydration
  // + design-oracle pre-row paths BEFORE the stage-level finalize guard is entered.
  // The stage-level classifier already carries a mirror arm for each (see
  // `stageFailureKind.ts` — `malformed_ancestor_stack`, `design_contract_corrupt`,
  // `design_oracle_actor_config`, `malformed_design_oracle_result`); these
  // worker-level arms preserve the typed diagnosis on `run.failed.failureCode` when
  // the throw escapes the stage boundary (or precedes any task row).
  MalformedAncestorStackError: {
    code: "malformed_ancestor_stack",
    stage: "bootstrap",
    summary: "the run's ancestor stack failed schema parse",
    cause: "ancestor_stack_malformed",
    // Tanren wrote the row it cannot now read back.
    attribution: "tanren",
  },
  DesignContractCorruptError: {
    code: "design_contract_corrupt",
    stage: "bootstrap",
    summary: "the persisted design contract failed schema parse",
    cause: "design_contract_corrupt",
    attribution: "tanren",
  },
  DesignOracleActorConfigError: {
    code: "design_oracle_actor_config",
    stage: "agent",
    summary: "the design oracle actor is misconfigured",
    cause: "design_oracle_actor_misconfigured",
    // The stage was invoked with an actor tanren itself assembled (a null-org actor).
    attribution: "tanren",
  },
  MalformedDesignOracleResultError: {
    code: "malformed_design_oracle_result",
    stage: "agent",
    summary: "the design oracle result was malformed",
    cause: "design_oracle_result_malformed",
    // The oracle answerer returned an incomplete result — a provider-behavior fault
    // more often than a tanren one, but the class name cannot prove either.
    attribution: "unknown",
  },
  // apex v82 defense-in-depth: mirror arm to `stageFailureKind.ts`'s
  // `spec_persistently_invalid`. A spec the spec-quality gate could not make valid at a
  // fixed point — a genuine "a human must clarify/split it" signal, NOT an internal
  // fault. Pulling it out of the opaque `internal` default gives the operator a
  // SPECIFIC needs_attention class on `run.failed`/`dag.spec.needs_attention`.
  PersistentlyInvalidSpecError: {
    code: "spec_persistently_invalid",
    stage: "agent",
    summary: "a spec could not be made valid and requires human attention",
    cause: "spec_persistently_invalid",
    // A spec the quality gate cannot make valid may be an unclear ask (the roadmap's
    // side) or a gate that is too strict (tanren's). Fails closed to `unknown`.
    attribution: "unknown",
  },
  SimulatedReviewPublicationError: {
    code: "merge",
    stage: "merge",
    summary: "strict simulated-review publication failed",
    cause: "simulated_review_publication_failed",
    attribution: "tanren",
  },
  SimulatedReviewPublishFenceBusyError: {
    code: "merge",
    stage: "merge",
    summary: "strict simulated-review publication is contended",
    cause: "simulated_review_publish_contended",
    attribution: "tanren",
  },
  SimulatedReviewHeadStaleError: {
    code: "merge",
    stage: "merge",
    summary: "the pull request advanced before strict simulated-review publication",
    cause: "simulated_review_head_stale",
    attribution: "tanren",
  },
};

const EXPLICIT_REVIEW_PUBLICATION_ERRORS = new Set([
  "SimulatedReviewPublicationError",
  "SimulatedReviewPublishFenceBusyError",
  "SimulatedReviewHeadStaleError",
]);

// Fail-closed default: an unrecognized error is the generic internal failure with a
// fixed summary — the raw message is NEVER passed through to the public summary.
const DEFAULT_FAILURE: ClassifiedRunFailure = {
  code: "internal",
  stage: "run",
  summary: "the run failed with an internal error",
  // The cause axis fails closed the same way the code axis does: an unrecognized
  // throw is `unclassified` / `unknown`, never a guess and never message-derived.
  // Every `unclassified` on the timeline is a MISSING ALLOWLIST ENTRY — the live
  // 93%-`internal` reading was exactly that signal, unread.
  cause: "unclassified",
  attribution: "unknown",
};

/**
 * Classify a caught run-level error into a public-safe `{ code, stage, summary }`.
 * Keys off `error.name` (the class name); an unknown/non-Error throw falls closed
 * to the generic internal failure. The returned strings are ALL safe for the public
 * `run.failed` event — none echo the raw error message.
 */
export function classifyRunFailure(error: unknown): ClassifiedRunFailure {
  // `Object.hasOwn`, NOT `!== undefined`: `BY_ERROR_NAME` is an object literal, so a bare
  // index lookup also resolves `Object.prototype` members. An error named `toString` /
  // `constructor` / `valueOf` would return an inherited FUNCTION, which is not `undefined`,
  // so the fail-closed default would be skipped and a classification whose every field is
  // `undefined` would flow into the strict `run.failed` / `dag.spec.redriven` payloads —
  // the exact opposite of this module's fail-closed contract.
  if (error instanceof Error && error.name !== "" && Object.hasOwn(BY_ERROR_NAME, error.name)) {
    const matched = BY_ERROR_NAME[error.name];
    if (matched !== undefined) {
      return matched;
    }
  }
  return DEFAULT_FAILURE;
}

/** Read the typed publication retry contract without trusting arbitrary error fields. */
export function explicitRunFailureRetryability(error: unknown): "retriable" | "non_retriable" | undefined {
  if (!(error instanceof Error) || !EXPLICIT_REVIEW_PUBLICATION_ERRORS.has(error.name)) return undefined;
  const retriable = (error as Error & { retriable?: unknown }).retriable;
  if (typeof retriable !== "boolean") return undefined;
  return retriable ? "retriable" : "non_retriable";
}
