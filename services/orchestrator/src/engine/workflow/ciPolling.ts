import { randomUUID } from "node:crypto";
import type pg from "pg";
import { migrateOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { validateGithubCredentialRef } from "../credentials/githubToken.js";
import { routeTaskUpdate } from "./taskWriteRouting.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import { type GitHubCheckRun, type GitHubCommitStatus, type GitHubPullRequestChecks } from "../providers/github.js";

type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

export type CiObservationStatus = "pending" | "passed" | "failed";
export type CiObservationReason = "no_checks" | "checks_pending" | "all_checks_passed" | "check_failed";

export interface CiObservation {
  status: CiObservationStatus;
  reason: CiObservationReason;
  headSha: string;
  checkRuns: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
  failingChecks: Array<{
    kind: "check_run" | "commit_status";
    name: string;
    state: string;
    url?: string;
  }>;
  pendingChecks: Array<{
    kind: "check_run" | "commit_status";
    name: string;
    state: string;
    url?: string;
  }>;
}

export interface PollCiForRunInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  // Plane-split P3c: route the CI task INSERT/UPDATE through the control plane
  // when wired (remote-writes on); absent, the in-process org-scoped write runs.
  runStateWriter?: RunStateWriter;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  runId: string;
  githubCredentialRef?: string;
  /** P3-0003: shared installation-token minter (cache lives here). */
  githubAppMinter?: GithubAppTokenMinter;
}

export interface PollCiForRunResult {
  runId: string;
  taskId: string;
  status: CiObservationStatus;
  reason: CiObservationReason;
  headSha: string;
  nextPollAfterMs?: number;
  summary: {
    checkRuns: number;
    statuses: number;
    failing: number;
    pending: number;
  };
}

export class CiRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run not found for CI polling: ${runId}`);
  }
}

export class CiPullRequestNotFoundError extends Error {
  constructor(runId: string) {
    super(`run has no pull request URL for CI polling: ${runId}`);
  }
}

export async function pollCiForRun(input: PollCiForRunInput): Promise<PollCiForRunResult> {
  const context = await loadCiRunContext(input.pool, input.runId);
  if (context === undefined) {
    throw new CiRunNotFoundError(input.runId);
  }
  if (context.prUrl === null) {
    throw new CiPullRequestNotFoundError(input.runId);
  }

  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const task = await ensureCiTask(input.pool, context, input.runStateWriter);
  if (task.created) {
    await eventStore.append({
      runId: context.runId,
      taskId: task.taskId,
      specId: context.specId,
      projectId: context.projectId,
      eventType: "task.started",
      payload: { taskKind: "ci" },
    });
  }
  const staticRef =
    context.installation === undefined
      ? githubCredentialRefFromInput(input.githubCredentialRef, context.projectConfig)
      : credentialRefOrUndefined(input.githubCredentialRef, context.projectConfig);
  const ledgerRef = context.installation?.credentialRef ?? staticRef ?? "github_app";
  const resolved = await input.vcsProvider.resolveToken({
    secrets: input.secrets,
    installation: context.installation,
    staticRef,
    minter: input.githubAppMinter,
  });
  const credentialRef = ledgerRef;
  const pr = input.vcsProvider.parsePullRequest(context.prUrl);
  const checks = await input.vcsProvider.readPullRequestChecks(pr, resolved);
  const observation = evaluateCiObservation(checks);
  await persistCiObservation(input.pool, task.taskId, observation, input.runStateWriter);

  const payload = ciEventPayload(context.prUrl, credentialRef, observation);
  await eventStore.append({
    runId: context.runId,
    taskId: task.taskId,
    specId: context.specId,
    projectId: context.projectId,
    eventType: eventTypeForObservation(observation),
    payload,
  });
  if (observation.status === "passed") {
    await eventStore.append({
      runId: context.runId,
      taskId: task.taskId,
      specId: context.specId,
      projectId: context.projectId,
      eventType: "task.completed",
      payload: { taskKind: "ci", status: observation.status, reason: observation.reason },
    });
  } else if (observation.status === "failed") {
    await eventStore.append({
      runId: context.runId,
      taskId: task.taskId,
      specId: context.specId,
      projectId: context.projectId,
      eventType: "task.failed",
      payload: {
        taskKind: "ci",
        failureKind: "ci_failed",
        status: observation.status,
        reason: observation.reason,
      },
    });
  }

  return {
    runId: context.runId,
    taskId: task.taskId,
    status: observation.status,
    reason: observation.reason,
    headSha: observation.headSha,
    nextPollAfterMs: observation.status === "pending" ? computeCiRetryDelayMs(task.attempt) : undefined,
    summary: {
      checkRuns: observation.checkRuns.length,
      statuses: observation.statuses.length,
      failing: observation.failingChecks.length,
      pending: observation.pendingChecks.length,
    },
  };
}

export function evaluateCiObservation(checks: GitHubPullRequestChecks): CiObservation {
  const allFailing = [
    ...checks.checkRuns.filter(isFailedCheckRun).map((check) => ({
      kind: "check_run" as const,
      name: check.name,
      state: check.conclusion ?? check.status,
      url: check.url,
    })),
    ...checks.statuses.filter(isFailedStatus).map((status) => ({
      kind: "commit_status" as const,
      name: status.context,
      state: status.state,
      url: status.url,
    })),
  ];
  const allPending = [
    ...checks.checkRuns.filter(isPendingCheckRun).map((check) => ({
      kind: "check_run" as const,
      name: check.name,
      state: check.status,
      url: check.url,
    })),
    ...checks.statuses.filter(isPendingStatus).map((status) => ({
      kind: "commit_status" as const,
      name: status.context,
      state: status.state,
      url: status.url,
    })),
  ];

  // P3-0028 required-check awareness. When branch protection declares required
  // contexts, the run is gated on THOSE only: an optional check failing/pending
  // does not block, and a required context that has not reported yet keeps the
  // run pending until it does.
  const required = checks.requiredContexts;
  const gated = required !== undefined && required.length > 0;
  const failingChecks = gated ? allFailing.filter((check) => required.includes(check.name)) : allFailing;
  const pendingChecks = gated ? allPending.filter((check) => required.includes(check.name)) : allPending;
  const missingRequired = gated ? missingRequiredContexts(required, checks) : [];

  const observed = checks.checkRuns.length + checks.statuses.length;
  let status: CiObservationStatus;
  let reason: CiObservationReason;
  if (failingChecks.length > 0) {
    status = "failed";
    reason = "check_failed";
  } else if (gated) {
    // Required gating: pass only when every required context is present + green.
    if (pendingChecks.length > 0 || missingRequired.length > 0) {
      status = "pending";
      reason = "checks_pending";
    } else {
      status = "passed";
      reason = "all_checks_passed";
    }
  } else if (observed === 0) {
    status = "pending";
    reason = "no_checks";
  } else if (pendingChecks.length > 0) {
    status = "pending";
    reason = "checks_pending";
  } else {
    status = "passed";
    reason = "all_checks_passed";
  }

  // Surface still-unreported required contexts as pending so the timeline shows
  // exactly what the run is waiting on.
  const pendingWithMissing = [
    ...pendingChecks,
    ...missingRequired.map((name) => ({ kind: "commit_status" as const, name, state: "expected" })),
  ];

  return {
    status,
    reason,
    headSha: checks.head.sha,
    checkRuns: checks.checkRuns,
    statuses: checks.statuses,
    failingChecks,
    pendingChecks: pendingWithMissing,
  };
}

function missingRequiredContexts(required: string[], checks: GitHubPullRequestChecks): string[] {
  const present = new Set<string>([
    ...checks.checkRuns.map((check) => check.name),
    ...checks.statuses.map((status) => status.context),
  ]);
  return required.filter((name) => !present.has(name));
}

export function computeCiRetryDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.min(attempt, 5));
  return Math.min(60_000, 5_000 * 2 ** (boundedAttempt - 1));
}

async function loadCiRunContext(pool: RunStateClient, runId: string): Promise<CiRunContext | undefined> {
  const result = await pool.query(
    `SELECT r.run_id, r.spec_id, r.project_id, r.pr_url, p.config, o.config AS org_config
     FROM runs r
     JOIN projects p ON p.project_id = r.project_id
     LEFT JOIN organizations o ON o.id = p.org_id
     WHERE r.run_id = $1`,
    [runId],
  );
  const row = result.rows[0] as CiRunRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    runId: row.run_id,
    specId: row.spec_id,
    projectId: row.project_id,
    prUrl: row.pr_url,
    projectConfig: asRecord(row.config),
    installation: installationFromOrgConfig(row.org_config),
  };
}

async function ensureCiTask(
  pool: RunStateClient,
  context: CiRunContext,
  writer?: RunStateWriter,
): Promise<{ taskId: string; attempt: number; created: boolean }> {
  // The SELECT is a READ — the data plane keeps `tasks` SELECT, so it always runs
  // in-process (the writer carries no read surface). Only the INSERT/UPDATE route.
  const existing = await pool.query(
    `SELECT task_id, attempt
     FROM tasks
     WHERE run_id = $1 AND kind = 'ci'
     ORDER BY started_at DESC NULLS LAST, task_id ASC
     LIMIT 1`,
    [context.runId],
  );
  const existingTask = existing.rows[0] as { task_id: string; attempt: number } | undefined;
  if (existingTask !== undefined) {
    const attempt = Number(existingTask.attempt) + 1;
    if (writer === undefined) {
      await pool.query(
        "UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, now()), attempt = $2 WHERE task_id = $1",
        [existingTask.task_id, attempt],
      );
    } else {
      await writer.updateTask({ taskId: existingTask.task_id, transition: "running_attempt", attempt });
    }
    return { taskId: existingTask.task_id, attempt, created: false };
  }

  const taskId = `task_${randomUUID()}`;
  if (writer === undefined) {
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, started_at, agent_kind, cli, model, attempt)
       VALUES ($1, $2, (SELECT org_id FROM runs WHERE run_id = $2), 'ci', 'Poll pull request CI', 'running', now(), 'system', 'github', NULL, 1)`,
      [taskId, context.runId],
    );
  } else {
    await writer.insertTask({
      taskId,
      runId: context.runId,
      kind: "ci",
      title: "Poll pull request CI",
      status: "running",
      agentKind: "system",
      cli: "github",
      model: null,
      setStartedAt: true,
      attempt: 1,
    });
  }
  return { taskId, attempt: 1, created: true };
}

async function persistCiObservation(
  pool: RunStateClient,
  taskId: string,
  observation: CiObservation,
  writer?: RunStateWriter,
): Promise<void> {
  if (observation.status === "passed") {
    await routeTaskUpdate(
      writer,
      pool,
      { taskId, transition: "done", outcome: "ok" },
      "UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1",
      [taskId],
    );
    return;
  }
  if (observation.status === "failed") {
    await routeTaskUpdate(
      writer,
      pool,
      { taskId, transition: "failed_with_kind", failureKind: "ci_failed" },
      "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = 'ci_failed', ended_at = now() WHERE task_id = $1",
      [taskId],
    );
    return;
  }
  await routeTaskUpdate(
    writer,
    pool,
    { taskId, transition: "running_pending_clear_failure" },
    "UPDATE tasks SET status = 'running', outcome = 'pending', ended_at = NULL, failure_kind = NULL WHERE task_id = $1",
    [taskId],
  );
}

function githubCredentialRefFromInput(override: string | undefined, projectConfig: Record<string, unknown>): string {
  const configured = override ?? projectConfig["githubCredentialRef"];
  if (typeof configured !== "string") {
    throw new TypeError("GitHub credential ref is required");
  }
  return validateGithubCredentialRef(configured);
}

function credentialRefOrUndefined(
  override: string | undefined,
  projectConfig: Record<string, unknown>,
): string | undefined {
  const configured = override ?? projectConfig["githubCredentialRef"];
  return typeof configured === "string" ? validateGithubCredentialRef(configured) : undefined;
}

function installationFromOrgConfig(orgConfig: unknown): OrgGithubAppInstallation | undefined {
  if (orgConfig === null || orgConfig === undefined) {
    return undefined;
  }
  try {
    return migrateOrgConfig(orgConfig).github_app;
  } catch {
    return undefined;
  }
}

function eventTypeForObservation(observation: CiObservation): "ci.started" | "ci.passed" | "ci.failed" {
  if (observation.status === "passed") {
    return "ci.passed";
  }
  if (observation.status === "failed") {
    return "ci.failed";
  }
  return "ci.started";
}

function ciEventPayload(prUrl: string, credentialRef: string, observation: CiObservation) {
  return {
    prUrl,
    credentialRef,
    redacted: true as const,
    status: observation.status,
    reason: observation.reason,
    headSha: observation.headSha,
    checkRuns: observation.checkRuns.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      url: check.url,
    })),
    statuses: observation.statuses.map((status) => ({
      context: status.context,
      state: status.state,
      url: status.url,
    })),
    failingChecks: observation.failingChecks,
    pendingChecks: observation.pendingChecks,
  };
}

function isFailedCheckRun(check: GitHubCheckRun): boolean {
  return check.status === "completed" && !successfulCheckConclusions.has(check.conclusion ?? "");
}

function isPendingCheckRun(check: GitHubCheckRun): boolean {
  return check.status !== "completed";
}

function isFailedStatus(status: GitHubCommitStatus): boolean {
  return status.state === "failure" || status.state === "error";
}

function isPendingStatus(status: GitHubCommitStatus): boolean {
  return status.state === "pending";
}

const successfulCheckConclusions = new Set(["success", "neutral", "skipped"]);

interface CiRunContext {
  runId: string;
  specId: string;
  projectId: string;
  prUrl: string | null;
  projectConfig: Record<string, unknown>;
  installation?: OrgGithubAppInstallation;
}

interface CiRunRow {
  run_id: string;
  spec_id: string;
  project_id: string;
  pr_url: string | null;
  config: unknown;
  org_config: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
