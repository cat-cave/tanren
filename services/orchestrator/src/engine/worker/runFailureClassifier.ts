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
