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
}

// error.name → (code, stage, summary). Keyed by the error CLASS name (stable),
// NOT the message. Every entry's summary is a fixed, human-authored, secret-free
// sentence — the operator/monitor sees WHAT failed + WHERE, never the raw detail.
const BY_ERROR_NAME: Readonly<Record<string, ClassifiedRunFailure>> = {
  WorkspaceBootstrapError: { code: "workspace", stage: "workspace", summary: "workspace bootstrap failed" },
  WorkspaceDepsInstallError: { code: "workspace", stage: "workspace", summary: "workspace dependency install failed" },
  MissingCredentialError: { code: "credential", stage: "credentials", summary: "a required credential is missing" },
  UnscopedOrgError: { code: "credential", stage: "credentials", summary: "credential resolution lost its org scope" },
  OrgProviderModeUnresolved: {
    code: "credential",
    stage: "credentials",
    summary: "the org's provider mode could not be resolved",
  },
  CodexUsageLimitError: { code: "usage_limit", stage: "agent", summary: "the agent hit its provider usage limit" },
  JobOrgContextLostError: { code: "internal", stage: "bootstrap", summary: "the run's org context was not reachable" },
  RunExecutionContextNotFoundError: {
    code: "internal",
    stage: "bootstrap",
    summary: "the run's execution context could not be loaded",
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
  },
  DesignContractCorruptError: {
    code: "design_contract_corrupt",
    stage: "bootstrap",
    summary: "the persisted design contract failed schema parse",
  },
  DesignOracleActorConfigError: {
    code: "design_oracle_actor_config",
    stage: "agent",
    summary: "the design oracle actor is misconfigured",
  },
  MalformedDesignOracleResultError: {
    code: "malformed_design_oracle_result",
    stage: "agent",
    summary: "the design oracle result was malformed",
  },
};

// Fail-closed default: an unrecognized error is the generic internal failure with a
// fixed summary — the raw message is NEVER passed through to the public summary.
const DEFAULT_FAILURE: ClassifiedRunFailure = {
  code: "internal",
  stage: "run",
  summary: "the run failed with an internal error",
};

/**
 * Classify a caught run-level error into a public-safe `{ code, stage, summary }`.
 * Keys off `error.name` (the class name); an unknown/non-Error throw falls closed
 * to the generic internal failure. The returned strings are ALL safe for the public
 * `run.failed` event — none echo the raw error message.
 */
export function classifyRunFailure(error: unknown): ClassifiedRunFailure {
  if (error instanceof Error && error.name !== "") {
    const matched = BY_ERROR_NAME[error.name];
    if (matched !== undefined) {
      return matched;
    }
  }
  return DEFAULT_FAILURE;
}
