// P3-0028 webhook-driven CI (option). GitHub can push `check_run` /
// `check_suite` / `status` webhook events when a PR's checks change state. This
// module resolves the affected run(s) from the webhook payload and advances
// their CI state by delegating to the authoritative `pollCiForRun` re-fetch —
// so the webhook is a low-latency *trigger*, not a trusted source of truth.
// Polling remains the default fallback; this route is purely additive.

import type pg from "pg";
import type { SecretStore } from "../contracts/secretStore.js";
import type { EventStore } from "../eventStore.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { type PollCiForRunResult, pollCiForRun } from "./ciPolling.js";

export class CiWebhookUnsupportedEventError extends Error {
  constructor(event: string) {
    super(`unsupported CI webhook event: ${event}`);
  }
}

export interface AdvanceCiFromWebhookInput {
  pool: pg.Pool;
  eventStore?: EventStore;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  /** GitHub `X-GitHub-Event` header value (e.g. `check_run`, `check_suite`, `status`). */
  event: string;
  /** Parsed webhook JSON body. */
  payload: unknown;
  githubCredentialRef?: string;
  githubAppMinter?: GithubAppTokenMinter;
}

export interface AdvanceCiFromWebhookResult {
  event: string;
  matchedRunIds: string[];
  results: PollCiForRunResult[];
}

const CI_EVENTS = new Set(["check_run", "check_suite", "status"]);

/**
 * Advance the CI state of every run whose PR head matches the webhook payload.
 * Returns the runs it advanced; an empty match list is a no-op (the webhook is
 * for a PR/commit this orchestrator isn't tracking).
 */
export async function advanceCiFromWebhook(input: AdvanceCiFromWebhookInput): Promise<AdvanceCiFromWebhookResult> {
  if (!CI_EVENTS.has(input.event)) {
    throw new CiWebhookUnsupportedEventError(input.event);
  }
  const prUrls = pullRequestUrlsFromPayload(input.payload);
  const runIds = await resolveRunIds(input.pool, prUrls);
  const results: PollCiForRunResult[] = [];
  for (const runId of runIds) {
    results.push(
      await pollCiForRun({
        pool: input.pool,
        eventStore: input.eventStore,
        secrets: input.secrets,
        githubHttp: input.githubHttp,
        runId,
        githubCredentialRef: input.githubCredentialRef,
        githubAppMinter: input.githubAppMinter
      })
    );
  }
  return { event: input.event, matchedRunIds: runIds, results };
}

/**
 * Extract candidate PR HTML URLs from a `check_run` / `check_suite` / `status`
 * webhook payload. GitHub nests the associated PRs under
 * `check_run.pull_requests[]` / `check_suite.pull_requests[]`; the `status`
 * event has no PRs, so we fall back to matching nothing (the poll fallback
 * still covers status-only repos).
 */
export function pullRequestUrlsFromPayload(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const object = payload as Record<string, unknown>;
  const container = (object.check_run ?? object.check_suite) as Record<string, unknown> | undefined;
  const pulls = container?.pull_requests ?? object.pull_requests;
  if (!Array.isArray(pulls)) {
    return [];
  }
  const urls = new Set<string>();
  for (const pull of pulls) {
    if (typeof pull !== "object" || pull === null) {
      continue;
    }
    const htmlUrl = (pull as Record<string, unknown>).html_url;
    if (typeof htmlUrl === "string" && htmlUrl !== "") {
      urls.add(htmlUrl);
    }
  }
  return [...urls];
}

async function resolveRunIds(pool: pg.Pool, prUrls: string[]): Promise<string[]> {
  if (prUrls.length === 0) {
    return [];
  }
  const result = await pool.query(
    "SELECT run_id FROM runs WHERE pr_url = ANY($1::text[]) ORDER BY started_at DESC NULLS LAST, run_id ASC",
    [prUrls]
  );
  return result.rows.map((row: { run_id: string }) => row.run_id);
}
