import { z } from "zod";
import { parseRefObjectSha } from "../providers/githubChecksParse.js";
import { repoPath, withErrorDetail, type GitHubHttpClient, type GitHubRepository } from "../providers/github.js";
import { validateGitBranchName, type GitHubPushLease } from "../workspace/githubPush.js";

type QueryClient = { query(sql: string, params: readonly unknown[]): Promise<{ rows: readonly unknown[] }> };

const PublishedHeadRow = z.object({ payload: z.unknown() });
const PublishedHeadPayload = z.object({ headSha: z.string().regex(/^[0-9a-f]{40}$/u) }).passthrough();

/**
 * Reads the last Tanren-published head for the stable spec-derived PR branch.
 * The immutable event ledger spans fresh successor runs, unlike in-process
 * rework state. A prior branch-push event without a valid CAS witness is an
 * unsafe history, not an absence proof.
 */
export async function readDurableDraftPrPublishedHead(
  pool: QueryClient,
  input: { orgId: string; specId: string; branch: string },
): Promise<string | undefined> {
  const branch = validateGitBranchName(input.branch);
  const result = await pool.query(
    `SELECT payload FROM events
     WHERE org_id = $1 AND spec_id = $2 AND event_type = 'github.branch.pushed'
       AND payload->>'branch' = $3
     ORDER BY ts DESC, id DESC
     LIMIT 1`,
    [input.orgId, input.specId, branch],
  );
  const raw = result.rows[0];
  if (raw === undefined) return undefined;
  const row = PublishedHeadRow.safeParse(raw);
  const payload = row.success ? PublishedHeadPayload.safeParse(row.data.payload) : undefined;
  if (payload === undefined || !payload.success) {
    throw new Error(`GitHub draft branch durable published head is invalid for ${branch}`);
  }
  return payload.data.headSha;
}

/**
 * Read the remote branch immediately before a draft/rework publication.  A 404
 * is an explicit absence proof; every other non-200 or malformed response fails
 * closed, so publication can be re-driven instead of overwriting unknown work.
 */
export async function readDraftPrPushLease(
  http: GitHubHttpClient,
  repo: GitHubRepository,
  branch: string,
  token: string,
  expectedPublishedHeadSha?: string,
): Promise<GitHubPushLease> {
  const validBranch = validateGitBranchName(branch);
  if (expectedPublishedHeadSha !== undefined && !/^[0-9a-f]{40}$/u.test(expectedPublishedHeadSha)) {
    throw new Error(`GitHub draft branch expected published head is invalid for ${validBranch}`);
  }
  const response = await http.request({
    method: "GET",
    path: repoPath(repo, `/git/ref/heads/${encodeURIComponent(validBranch)}`),
    token,
    // The caller owns recovery. Do not hide a stale observation behind retries.
    retryTransient: false,
    retryRateLimit: false,
  });
  if (response.status === 404 && expectedPublishedHeadSha === undefined) return { expectedAbsent: true };
  const sha = parseRefObjectSha(response.body);
  if (response.status !== 200 || sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(
      withErrorDetail(`GitHub draft branch read failed for ${validBranch}: HTTP ${response.status}`, response),
    );
  }
  if (expectedPublishedHeadSha !== undefined && sha !== expectedPublishedHeadSha) {
    throw new Error(`GitHub draft branch changed since workspace rework for ${validBranch}`);
  }
  return { expectedSha: sha };
}
