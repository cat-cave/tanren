import { createHash } from "node:crypto";
import { z } from "zod";
import type { GitHubHttpClient, GitHubRepository } from "../providers/github.js";
import { readDraftPrPushLease } from "./githubDraftPrLease.js";
import type { GitHubPushLease } from "../workspace/githubPush.js";

type QueryClient = { query(sql: string, params: readonly unknown[]): Promise<{ rows: readonly unknown[] }> };

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const Sha = z.string().regex(SHA_PATTERN);
const IntentRow = z.object({
  intent_id: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  run_id: z.string(),
  spec_id: z.string(),
  repo_url: z.string(),
  branch: z.string(),
  intended_sha: Sha,
  source_ref: Sha,
  lease_predecessor_sha: Sha.nullable(),
  status: z.enum(["pending", "completed"]),
});

export interface DraftPushIntent {
  intentId: string;
  orgId: string;
  projectId: string;
  runId: string;
  specId: string;
  repoUrl: string;
  branch: string;
  intendedSha: string;
  sourceRef: string;
  leasePredecessorSha: string | undefined;
  status: "pending" | "completed";
}

export interface DraftPushIntentContext {
  orgId: string;
  projectId: string;
  runId: string;
  specId: string;
  repoUrl: string;
  branch: string;
}

export interface DraftPushIntentCandidate extends DraftPushIntentContext {
  intendedSha: string;
  sourceRef: string;
  leasePredecessorSha: string | undefined;
}

export interface PreparedDraftPushIntent {
  intent: DraftPushIntent;
  forceWithLease: GitHubPushLease;
}

function decodeIntent(raw: unknown): DraftPushIntent {
  const row = IntentRow.parse(raw);
  return {
    intentId: row.intent_id,
    orgId: row.org_id,
    projectId: row.project_id,
    runId: row.run_id,
    specId: row.spec_id,
    repoUrl: row.repo_url,
    branch: row.branch,
    intendedSha: row.intended_sha,
    sourceRef: row.source_ref,
    leasePredecessorSha: row.lease_predecessor_sha ?? undefined,
    status: row.status,
  };
}

function assertIntentContext(intent: DraftPushIntent, context: DraftPushIntentContext): void {
  if (
    intent.orgId !== context.orgId ||
    intent.projectId !== context.projectId ||
    intent.runId !== context.runId ||
    intent.specId !== context.specId ||
    intent.repoUrl !== context.repoUrl ||
    intent.branch !== context.branch
  ) {
    throw new Error(`GitHub draft push intent ownership mismatch for ${context.branch}`);
  }
}

function validateCandidate(candidate: DraftPushIntentCandidate): void {
  if (!SHA_PATTERN.test(candidate.intendedSha) || !SHA_PATTERN.test(candidate.sourceRef)) {
    throw new Error(`GitHub draft push intent immutable SHA is invalid for ${candidate.branch}`);
  }
  if (candidate.sourceRef !== candidate.intendedSha) {
    throw new Error(`GitHub draft push intent source ref must equal intended SHA for ${candidate.branch}`);
  }
  if (candidate.leasePredecessorSha !== undefined && !SHA_PATTERN.test(candidate.leasePredecessorSha)) {
    throw new Error(`GitHub draft push intent lease predecessor is invalid for ${candidate.branch}`);
  }
}

function intentIdFor(candidate: DraftPushIntentCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        candidate.orgId,
        candidate.projectId,
        candidate.runId,
        candidate.specId,
        candidate.repoUrl,
        candidate.branch,
        candidate.intendedSha,
        candidate.sourceRef,
        candidate.leasePredecessorSha ?? null,
      ]),
    )
    .digest("hex");
}

const intentColumns = `intent_id, org_id, project_id, run_id, spec_id, repo_url, branch,
  intended_sha, source_ref, lease_predecessor_sha, status`;

/** Read the one live intent that owns this org/spec/branch before any new commit is built. */
export async function findPendingDraftPushIntent(
  pool: QueryClient,
  context: DraftPushIntentContext,
): Promise<DraftPushIntent | undefined> {
  const result = await pool.query(
    `SELECT ${intentColumns}
     FROM github_push_intents
     WHERE org_id = $1 AND spec_id = $2 AND branch = $3 AND status = 'pending'
     ORDER BY created_at DESC, intent_id DESC
     LIMIT 1`,
    [context.orgId, context.specId, context.branch],
  );
  const raw = result.rows[0];
  if (raw === undefined) return undefined;
  const intent = decodeIntent(raw);
  assertIntentContext(intent, context);
  return intent;
}

async function readIntentById(
  pool: QueryClient,
  orgId: string,
  intentId: string,
): Promise<DraftPushIntent | undefined> {
  const result = await pool.query(
    `SELECT ${intentColumns} FROM github_push_intents WHERE org_id = $1 AND intent_id = $2 LIMIT 1`,
    [orgId, intentId],
  );
  const raw = result.rows[0];
  return raw === undefined ? undefined : decodeIntent(raw);
}

/** Insert once, then recover the winning row if another publisher raced this one. */
export async function persistDraftPushIntent(
  pool: QueryClient,
  candidate: DraftPushIntentCandidate,
): Promise<DraftPushIntent> {
  validateCandidate(candidate);
  const intentId = intentIdFor(candidate);
  await pool.query(
    `INSERT INTO github_push_intents (
       intent_id, org_id, project_id, run_id, spec_id, repo_url, branch,
       intended_sha, source_ref, lease_predecessor_sha, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
     ON CONFLICT DO NOTHING`,
    [
      intentId,
      candidate.orgId,
      candidate.projectId,
      candidate.runId,
      candidate.specId,
      candidate.repoUrl,
      candidate.branch,
      candidate.intendedSha,
      candidate.sourceRef,
      candidate.leasePredecessorSha ?? null,
    ],
  );
  const exact = await readIntentById(pool, candidate.orgId, intentId);
  if (exact !== undefined) {
    assertIntentContext(exact, candidate);
    return exact;
  }
  const winner = await findPendingDraftPushIntent(pool, candidate);
  if (winner === undefined) throw new Error(`GitHub draft push intent disappeared for ${candidate.branch}`);
  return winner;
}

/** Re-read the remote ref against the persisted predecessor; unknown state fails closed. */
export async function reconcileDraftPushIntent(input: {
  intent: DraftPushIntent;
  http: GitHubHttpClient;
  repo: GitHubRepository;
  token: string;
}): Promise<GitHubPushLease> {
  return await readDraftPrPushLease(
    input.http,
    input.repo,
    input.intent.branch,
    input.token,
    input.intent.leasePredecessorSha,
    input.intent.intendedSha,
  );
}

/** Read, persist, and reconcile the write-ahead intent before the first remote CAS. */
export async function prepareDraftPushIntent(input: {
  pool: QueryClient;
  context: DraftPushIntentContext;
  intendedSha: string;
  sourceRef: string;
  expectedPublishedHeadSha?: string;
  http: GitHubHttpClient;
  repo: GitHubRepository;
  token: string;
}): Promise<PreparedDraftPushIntent> {
  const pending = await findPendingDraftPushIntent(input.pool, input.context);
  if (pending !== undefined) {
    return { intent: pending, forceWithLease: await reconcileDraftPushIntent({ ...input, intent: pending }) };
  }

  const lease = await readDraftPrPushLease(
    input.http,
    input.repo,
    input.context.branch,
    input.token,
    input.expectedPublishedHeadSha,
  );
  const candidate: DraftPushIntentCandidate = {
    ...input.context,
    intendedSha: input.intendedSha,
    sourceRef: input.sourceRef,
    leasePredecessorSha: "expectedSha" in lease ? lease.expectedSha : undefined,
  };
  const intent = await persistDraftPushIntent(input.pool, candidate);
  if (intent.intentId === intentIdFor(candidate)) return { intent, forceWithLease: lease };
  return { intent, forceWithLease: await reconcileDraftPushIntent({ ...input, intent }) };
}

/** Complete only after the event-store witness append has returned successfully. */
export async function completeDraftPushIntent(
  pool: QueryClient,
  intent: DraftPushIntent,
  witnessSha: string,
): Promise<void> {
  if (intent.status !== "pending") return;
  if (intent.intendedSha !== witnessSha) {
    throw new Error(`GitHub draft push intent witness SHA mismatch for ${intent.branch}`);
  }
  await pool.query(
    `UPDATE github_push_intents
     SET status = 'completed', completed_at = now()
     WHERE org_id = $1 AND intent_id = $2 AND status = 'pending' AND intended_sha = $3`,
    [intent.orgId, intent.intentId, witnessSha],
  );
}
