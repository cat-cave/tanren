// shared utilities for `just acceptance-easy` and `just
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
import { AcceptanceConfigError, loadAcceptanceConfig, type AcceptanceConfig } from "./config.js";

// -- back-compat aliases (existing callers spell these in camelCase) ------

export type AcceptanceEnv = AcceptanceEnvShape;

interface AcceptanceEnvShape {
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
  configSource: string;
}

export class AcceptanceEnvError extends Error {}

// loadAcceptanceEnv is retained for back-compat as a thin async-to-sync
// shim around loadAcceptanceConfig. New callers should prefer
// loadAcceptanceConfig directly.
export async function loadAcceptanceEnv(): Promise<AcceptanceEnvShape> {
  let config: AcceptanceConfig;
  try {
    config = await loadAcceptanceConfig();
  } catch (error) {
    if (error instanceof AcceptanceConfigError) {
      throw new AcceptanceEnvError(error.message);
    }
    throw error;
  }
  return {
    codexAuthJsonFile: config.codex_auth_file,
    githubTokenFile: config.github_token_file,
    githubRepoUrl: config.github_repo_url,
    databaseUrl: config.database_url,
    vaultAddr: config.vault_addr,
    vaultToken: config.vault_token,
    sshKeyPath: config.ssh_key_path,
    sshHost: config.ssh_host,
    sshPort: config.ssh_port,
    sshUser: config.ssh_user,
    sshHostFingerprint: config.ssh_host_fingerprint,
    baseBranch: config.github_base_branch ?? "main",
    timeoutMs: config.timeout_ms,
    maxCiPolls: config.max_ci_polls,
    ciPollDelayMs: config.ci_poll_delay_ms,
    configSource: config.source,
  };
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
  tier: "easy" | "medium",
): Promise<AcceptanceContext> {
  const pool = createDbPool(env.databaseUrl);
  await migrate(pool);

  const secrets = new VaultSecretStore({ addr: env.vaultAddr, token: env.vaultToken });
  const codexCredentialRef = `credential/codex/phase2-acceptance-${tier}`;
  const githubCredentialRef = `credential/github/phase2-acceptance-${tier}`;
  const identitySecretRef = `runner/acceptance-${tier}/identity`;

  await storeCodexAuthBundle(secrets, {
    ref: codexCredentialRef,
    authJson: await readFile(env.codexAuthJsonFile, "utf8"),
  });
  await storeGithubToken(secrets, {
    ref: githubCredentialRef,
    token: (await readFile(env.githubTokenFile, "utf8")).trim(),
  });
  await secrets.put({ ref: identitySecretRef, value: await readFile(env.sshKeyPath, "utf8") });

  return {
    pool,
    secrets,
    codexCredentialRef,
    githubCredentialRef,
    identitySecretRef,
    env,
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
  // One row per recorded cost_records entry: the task kind and how the dollar
  // figure was derived (cost_basis). 'unknown' is a legitimate, allowed basis.
  costBases: { taskKind: string; basis: string; billingMode: string }[];
  events: string[];
  plannerRerequestedCount: number;
  workspacePathHints: string[];
  ciStatus: "passed" | "failed" | "unknown";
}

// loadRunSnapshot pulls just the rows the acceptance assertions read. We
// keep the SQL here rather than in the orchestrator engine so the gate's
// observation surface is independent of internal code paths.
export async function loadRunSnapshot(pool: pg.Pool, runId: string): Promise<PersistedRunSnapshot> {
  const runRow = await pool.query<{
    status: string;
    outcome: string | null;
    pr_url: string | null;
  }>("SELECT status, outcome, pr_url FROM runs WHERE run_id = $1", [runId]);
  if (runRow.rowCount === 0) {
    throw new AcceptanceAssertionError(`run not found: ${runId}`);
  }

  const taskRows = await pool.query<{ kind: string }>(
    "SELECT kind FROM tasks WHERE run_id = $1 ORDER BY started_at ASC NULLS LAST, task_id ASC",
    [runId],
  );
  const taskKinds = taskRows.rows.map((row) => row.kind);
  const counts = { plan: 0, write: 0, check: 0, audit: 0, ci: 0 };
  for (const kind of taskKinds) {
    if (kind in counts) {
      counts[kind as keyof typeof counts] += 1;
    }
  }

  const costRows = await pool.query<{
    task_kind: string;
    cost_basis: string;
    billing_mode: string;
  }>(
    `SELECT t.kind AS task_kind, cr.cost_basis, cr.billing_mode
       FROM cost_records cr
       JOIN tasks t ON t.task_id = cr.task_id
      WHERE cr.run_id = $1
      ORDER BY cr.recorded_at ASC, cr.id ASC`,
    [runId],
  );

  const eventRows = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM events WHERE run_id = $1 ORDER BY ts ASC, id ASC",
    [runId],
  );
  const events = eventRows.rows.map((row) => row.event_type);
  const plannerRerequestedCount = events.filter((name) => name === "planner.rerequested").length;
  const ciStatus = events.includes("ci.passed") ? "passed" : events.includes("ci.failed") ? "failed" : "unknown";
  const workspacePathHints = events.filter((name) => name.startsWith("workspace.") || name === "runner.allocated");

  return {
    runId,
    status: runRow.rows[0]?.status ?? "",
    outcome: runRow.rows[0]?.outcome ?? null,
    prUrl: runRow.rows[0]?.pr_url ?? null,
    taskKinds,
    taskCounts: counts,
    costBases: costRows.rows.map((row) => ({
      taskKind: row.task_kind,
      basis: row.cost_basis,
      billingMode: row.billing_mode,
    })),
    events,
    plannerRerequestedCount,
    workspacePathHints,
    ciStatus,
  };
}

export class AcceptanceAssertionError extends Error {
  constructor(
    message: string,
    readonly runId?: string,
  ) {
    super(message);
  }
}

export interface AcceptanceCriteriaInput {
  tier: "easy" | "medium";
  // A merged run finalizes on the canonical `ok` success outcome for both tiers
  // (the synthetic per-tier `phase2_*_complete` residue was pruned with the old
  // hello/phase validation fixtures).
  expectedOutcome: "ok";
  snapshot: PersistedRunSnapshot;
}

// assertAcceptanceCriteria implements the spec's persisted-state assertions
// for both tiers. Easy: writer/checker/auditor cost records + PR URL + CI
// pass + correct outcome. Medium adds the planner cost + ≥ 2 writer tasks
// (subtasks). Post-PR GitHub CI is the deterministic test gate for both tiers.
//
// NOTE: an earlier medium assertion required ≥ 1 planner.rerequested event.
// That was mis-specified — it asserted nondeterministic LLM behavior (a
// checker rejection) as a hard gate, which conflated the agent's read-only
// reasoning with a deterministic test result. The checker-rejection loop is a
// capability that is exercised when the writer's first attempt is inadequate;
// it is proven by the loop's tests and observed opportunistically in live
// runs, not asserted on every run. The deterministic "tests pass" signal lives
// in post-PR CI here, and in the in-loop gate-check stage.
export function assertAcceptanceCriteria(input: AcceptanceCriteriaInput): void {
  const { tier, expectedOutcome, snapshot } = input;
  const failures: string[] = [];

  if (snapshot.outcome !== expectedOutcome) {
    failures.push(`expected run.outcome=${expectedOutcome}, got ${String(snapshot.outcome)}`);
  }
  if (snapshot.prUrl === null || !/^https:\/\/github\.com\/.+\/pull\/\d+$/u.test(snapshot.prUrl)) {
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
  const observedCostKinds = new Set(snapshot.costBases.map((row) => row.taskKind));
  const missingCostKinds = requiredCostKinds.filter((kind) => !observedCostKinds.has(kind));
  if (missingCostKinds.length > 0) {
    failures.push(`missing cost_records for task kinds: ${missingCostKinds.join(", ")}`);
  }
  // Token accounting is mandatory; cost is best-effort, so 'unknown' cost_basis
  // is allowed. Every row must still carry a billing_mode (the credential's
  // billing classification is never empty).
  const missingBillingMode = snapshot.costBases.filter((row) => row.billingMode === "");
  if (missingBillingMode.length > 0) {
    failures.push(`cost_records missing billing_mode: ${missingBillingMode.length}`);
  }

  if (tier === "medium" && snapshot.taskCounts.write < 2) {
    failures.push(`medium tier expects ≥ 2 write tasks (subtasks), got ${snapshot.taskCounts.write}`);
  }

  if (failures.length > 0) {
    throw new AcceptanceAssertionError(
      `acceptance criteria failed for ${tier} tier:\n  - ${failures.join("\n  - ")}`,
      snapshot.runId,
    );
  }
}

// -- proof block ----------------------------------------------------------

// printProofBlock emits the structured evidence block the operator pastes
// into ROADMAP.md as completion evidence. The format mirrors the
// "Current live proof" sentence the spec references.
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
    `costRecords     : ${snapshot.costBases.length} (${snapshot.costBases.map((c) => `${c.taskKind}:${c.billingMode}/${c.basis}`).join(", ")})`,
    `plannerReruns   : ${snapshot.plannerRerequestedCount}`,
    `repo            : ${repoUrl}`,
    `duration_s      : ${durationS}`,
    `events_total    : ${snapshot.events.length}`,
    "==========================================",
    "Paste this block into ROADMAP.md under the Phase 2A live proof section.",
    "",
  ].join("\n");
  process.stdout.write(`${block}\n`);
}
