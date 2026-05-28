// P2A-0015: shared utilities for `just acceptance-easy` and `just
// acceptance-medium`. The acceptance gate runs locally with live Codex +
// GitHub credentials; this module owns env loading, the persisted-state
// assertions both tiers share, and the proof-block printer the operator
// pastes into ROADMAP.md as completion evidence.
//
// NEVER intended for CI: the gate calls real Codex and creates real draft
// PRs. The `just acceptance` recipes are documented as local-only in
// docs/operator-guide/acceptance.md.

import { readFile } from "node:fs/promises";
import type pg from "pg";
// @tanren/db is a workspace package; scripts/ lives outside the workspace
// so we import its source directly. Tsx resolves the .ts extension at
// runtime; the orchestrator and tests use the workspace alias and the
// behavior is identical.
import { createDbPool, migrate } from "../../db/src/index.js";
import { VaultSecretStore, type SecretStore } from "../../services/orchestrator/src/engine/contracts/secretStore.js";
import { storeCodexAuthBundle } from "../../services/orchestrator/src/engine/credentials/codexAuth.js";
import { storeGithubToken } from "../../services/orchestrator/src/engine/credentials/githubToken.js";

// -- env loading -----------------------------------------------------------

const REQUIRED_ENV = [
  "TANREN_CODEX_AUTH_JSON_FILE",
  "TANREN_GITHUB_TOKEN_FILE",
  "TANREN_GITHUB_REPO_URL",
  "TANREN_DATABASE_URL",
  "TANREN_VAULT_TOKEN"
] as const;

export interface AcceptanceEnv {
  codexAuthJsonFile: string;
  githubTokenFile: string;
  githubRepoUrl: string;
  databaseUrl: string;
  vaultAddr: string;
  vaultToken: string;
  sshKeyPath: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshHostFingerprint: string;
  baseBranch: string;
  timeoutMs: number;
  maxCiPolls: number;
  ciPollDelayMs: number;
}

export class AcceptanceEnvError extends Error {}

export function loadAcceptanceEnv(): AcceptanceEnv {
  const missing = REQUIRED_ENV.filter((name) => !nonEmpty(process.env[name]));
  if (missing.length > 0) {
    throw new AcceptanceEnvError(`required env vars missing: ${missing.join(", ")}`);
  }
  return {
    codexAuthJsonFile: requireEnv("TANREN_CODEX_AUTH_JSON_FILE"),
    githubTokenFile: requireEnv("TANREN_GITHUB_TOKEN_FILE"),
    githubRepoUrl: requireEnv("TANREN_GITHUB_REPO_URL"),
    databaseUrl: requireEnv("TANREN_DATABASE_URL"),
    vaultAddr: process.env.TANREN_VAULT_ADDR ?? "http://127.0.0.1:18200",
    vaultToken: requireEnv("TANREN_VAULT_TOKEN"),
    sshKeyPath: process.env.TANREN_SSH_KEY_PATH ?? "/tmp/tanren_runner_key",
    sshHost: process.env.TANREN_SSH_HOST ?? "127.0.0.1",
    sshPort: Number(process.env.TANREN_SSH_PORT ?? "2222"),
    sshUser: process.env.TANREN_SSH_USER ?? "tanren",
    sshHostFingerprint: requireEnv("TANREN_SSH_HOST_FINGERPRINT"),
    baseBranch: process.env.TANREN_GITHUB_BASE_BRANCH ?? "main",
    timeoutMs: Number(process.env.TANREN_ACCEPTANCE_TIMEOUT_MS ?? "300000"),
    maxCiPolls: Number(process.env.TANREN_ACCEPTANCE_MAX_CI_POLLS ?? "18"),
    ciPollDelayMs: Number(process.env.TANREN_ACCEPTANCE_CI_POLL_DELAY_MS ?? "10000")
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!nonEmpty(value)) {
    throw new AcceptanceEnvError(`${name} is required`);
  }
  return value as string;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

// -- secrets + db ---------------------------------------------------------

export interface AcceptanceContext {
  pool: pg.Pool;
  secrets: SecretStore;
  codexCredentialRef: string;
  githubCredentialRef: string;
  identitySecretRef: string;
  env: AcceptanceEnv;
}

export async function bootstrapAcceptanceContext(
  env: AcceptanceEnv,
  tier: "easy" | "medium"
): Promise<AcceptanceContext> {
  const pool = createDbPool(env.databaseUrl);
  await migrate(pool);

  const secrets = new VaultSecretStore({ addr: env.vaultAddr, token: env.vaultToken });
  const codexCredentialRef = `credential/codex/phase2-acceptance-${tier}`;
  const githubCredentialRef = `credential/github/phase2-acceptance-${tier}`;
  const identitySecretRef = `runner/acceptance-${tier}/identity`;

  await storeCodexAuthBundle(secrets, {
    ref: codexCredentialRef,
    authJson: await readFile(env.codexAuthJsonFile, "utf8")
  });
  await storeGithubToken(secrets, {
    ref: githubCredentialRef,
    token: (await readFile(env.githubTokenFile, "utf8")).trim()
  });
  await secrets.put({ ref: identitySecretRef, value: await readFile(env.sshKeyPath, "utf8") });

  return {
    pool,
    secrets,
    codexCredentialRef,
    githubCredentialRef,
    identitySecretRef,
    env
  };
}

// -- persisted-state assertions -------------------------------------------

export interface PersistedRunSnapshot {
  runId: string;
  status: string;
  outcome: string | null;
  prUrl: string | null;
  taskKinds: string[];
  taskCounts: { plan: number; write: number; check: number; audit: number; ci: number };
  costSources: { taskKind: string; source: string }[];
  events: string[];
  plannerRerequestedCount: number;
  workspacePathHints: string[];
  ciStatus: "passed" | "failed" | "unknown";
}

// loadRunSnapshot pulls just the rows the acceptance assertions read. We
// keep the SQL here rather than in the orchestrator engine so the gate's
// observation surface is independent of internal code paths.
export async function loadRunSnapshot(pool: pg.Pool, runId: string): Promise<PersistedRunSnapshot> {
  const runRow = await pool.query<{ status: string; outcome: string | null; pr_url: string | null }>(
    "SELECT status, outcome, pr_url FROM runs WHERE run_id = $1",
    [runId]
  );
  if (runRow.rowCount === 0) {
    throw new AcceptanceAssertionError(`run not found: ${runId}`);
  }

  const taskRows = await pool.query<{ kind: string }>(
    "SELECT kind FROM tasks WHERE run_id = $1 ORDER BY started_at ASC NULLS LAST, task_id ASC",
    [runId]
  );
  const taskKinds = taskRows.rows.map((row) => row.kind);
  const counts = { plan: 0, write: 0, check: 0, audit: 0, ci: 0 };
  for (const kind of taskKinds) {
    if (kind in counts) {
      counts[kind as keyof typeof counts] += 1;
    }
  }

  const costRows = await pool.query<{ task_kind: string; cost_source: string }>(
    `SELECT t.kind AS task_kind, cr.cost_source
       FROM cost_records cr
       JOIN tasks t ON t.task_id = cr.task_id
      WHERE cr.run_id = $1
      ORDER BY cr.recorded_at ASC, cr.id ASC`,
    [runId]
  );

  const eventRows = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM events WHERE run_id = $1 ORDER BY ts ASC, id ASC",
    [runId]
  );
  const events = eventRows.rows.map((row) => row.event_type);
  const plannerRerequestedCount = events.filter((name) => name === "planner.rerequested").length;
  const ciStatus = events.includes("ci.passed")
    ? "passed"
    : events.includes("ci.failed")
      ? "failed"
      : "unknown";
  const workspacePathHints = events.filter((name) => name.startsWith("workspace.") || name === "runner.allocated");

  return {
    runId,
    status: runRow.rows[0]?.status ?? "",
    outcome: runRow.rows[0]?.outcome ?? null,
    prUrl: runRow.rows[0]?.pr_url ?? null,
    taskKinds,
    taskCounts: counts,
    costSources: costRows.rows.map((row) => ({ taskKind: row.task_kind, source: row.cost_source })),
    events,
    plannerRerequestedCount,
    workspacePathHints,
    ciStatus
  };
}

export class AcceptanceAssertionError extends Error {
  constructor(message: string, readonly runId?: string) {
    super(message);
  }
}

export interface AcceptanceCriteriaInput {
  tier: "easy" | "medium";
  expectedOutcome: "phase2_easy_complete" | "phase2_medium_complete";
  snapshot: PersistedRunSnapshot;
}

// assertAcceptanceCriteria implements the spec's persisted-state assertions
// for both tiers. Easy: writer/checker/auditor cost records + PR URL + CI
// pass + correct outcome. Medium: planner cost present, ≥ 2 writer tasks
// (subtasks), ≥ 1 planner.rerequested event (checker rejection loop).
export function assertAcceptanceCriteria(input: AcceptanceCriteriaInput): void {
  const { tier, expectedOutcome, snapshot } = input;
  const failures: string[] = [];

  if (snapshot.outcome !== expectedOutcome) {
    failures.push(`expected run.outcome=${expectedOutcome}, got ${String(snapshot.outcome)}`);
  }
  if (snapshot.prUrl === null || !/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(snapshot.prUrl)) {
    failures.push(`expected persisted pr_url to look like a GitHub PR URL, got ${String(snapshot.prUrl)}`);
  }
  if (snapshot.ciStatus !== "passed") {
    failures.push(`expected ci.passed event in the timeline (got ciStatus=${snapshot.ciStatus})`);
  }

  // Required cost roles: easy requires writer/checker/auditor; medium adds
  // planner because runSubtaskLoop emits a planner cost. Both tiers also
  // accept additional sources (e.g. subscription-window denominator refines).
  const requiredCostKinds: string[] =
    tier === "easy" ? ["write", "check", "audit"] : ["plan", "write", "check", "audit"];
  const observedCostKinds = new Set(snapshot.costSources.map((row) => row.taskKind));
  const missingCostKinds = requiredCostKinds.filter((kind) => !observedCostKinds.has(kind));
  if (missingCostKinds.length > 0) {
    failures.push(`missing cost_records for task kinds: ${missingCostKinds.join(", ")}`);
  }
  const unknownSources = snapshot.costSources.filter((row) => row.source === "unknown" || row.source === "");
  if (unknownSources.length > 0) {
    failures.push(`cost_records have unknown source rows: ${unknownSources.length}`);
  }

  if (tier === "medium") {
    if (snapshot.taskCounts.write < 2) {
      failures.push(`medium tier expects ≥ 2 write tasks (subtasks), got ${snapshot.taskCounts.write}`);
    }
    if (snapshot.plannerRerequestedCount < 1) {
      failures.push(
        `medium tier expects ≥ 1 planner.rerequested event (checker rejection loop), got ${snapshot.plannerRerequestedCount}`
      );
    }
  }

  if (failures.length > 0) {
    throw new AcceptanceAssertionError(
      `acceptance criteria failed for ${tier} tier:\n  - ${failures.join("\n  - ")}`,
      snapshot.runId
    );
  }
}

// -- proof block ----------------------------------------------------------

// printProofBlock emits the structured evidence block the operator pastes
// into ROADMAP.md as Phase 2A completion evidence. The format mirrors the
// Phase 1 "Current live proof" sentence the spec references.
export function printProofBlock(input: {
  tier: "easy" | "medium";
  snapshot: PersistedRunSnapshot;
  repoUrl: string;
  startedAt: Date;
  endedAt: Date;
}): void {
  const { tier, snapshot, repoUrl, startedAt, endedAt } = input;
  const durationS = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  const block = [
    "",
    "==========================================",
    `  Tanren Phase 2A — acceptance-${tier} proof`,
    "==========================================",
    `runId           : ${snapshot.runId}`,
    `outcome         : ${String(snapshot.outcome)}`,
    `status          : ${snapshot.status}`,
    `prUrl           : ${String(snapshot.prUrl)}`,
    `ciStatus        : ${snapshot.ciStatus}`,
    `tasks           : ${snapshot.taskKinds.join(", ")}`,
    `costRecords     : ${snapshot.costSources.length} (${snapshot.costSources.map((c) => `${c.taskKind}:${c.source}`).join(", ")})`,
    `plannerReruns   : ${snapshot.plannerRerequestedCount}`,
    `repo            : ${repoUrl}`,
    `duration_s      : ${durationS}`,
    `events_total    : ${snapshot.events.length}`,
    "==========================================",
    "Paste this block into ROADMAP.md under the Phase 2A live proof section.",
    ""
  ].join("\n");
  process.stdout.write(`${block}\n`);
}
