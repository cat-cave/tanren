import { randomUUID } from "node:crypto";
import type { CraConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { GithubDiscovery, selectReviewCandidates, type DiscoveredPullRequest } from "./discovery.js";
import { EventLog } from "./eventLog.js";
import { GithubAppIdentity } from "./githubApp.js";
import { SingletonLease } from "./singleton.js";
import { PrStateStore } from "./stateStore.js";
import type { PrState } from "./stateSchemas.js";

export interface PollOnceResult {
  readonly actor: string;
  readonly openPullRequests: number;
  readonly candidates: readonly DiscoveredPullRequest[];
}

function initialState(pr: DiscoveredPullRequest, config: CraConfig): PrState {
  return {
    pr: pr.number,
    lastSeenHeadSha: pr.headSha,
    lastReviewedHeadSha: null,
    lastReviewedBaseSha: null,
    rubricVersion: config.rubricVersion,
    reviewId: null,
    findingIds: [],
    disposition: "pending",
    firstAuthorActivityAt: pr.firstAuthorActivityAt,
    lastAuthorActivityAt: pr.lastAuthorActivityAt,
    awaitingAuthorSince: null,
    retry: { attempts: 0, nextAttemptAt: null, lastError: null },
    followUpIssues: [],
    auditStatus: "idle",
  };
}

function observedState(pr: DiscoveredPullRequest, previous: PrState): PrState {
  return {
    ...previous,
    lastSeenHeadSha: pr.headSha,
    firstAuthorActivityAt:
      previous.firstAuthorActivityAt < pr.firstAuthorActivityAt
        ? previous.firstAuthorActivityAt
        : pr.firstAuthorActivityAt,
    lastAuthorActivityAt:
      previous.lastAuthorActivityAt > pr.lastAuthorActivityAt ? previous.lastAuthorActivityAt : pr.lastAuthorActivityAt,
  };
}

export async function pollOnce(configFile?: string): Promise<PollOnceResult> {
  const { config, paths } = await loadConfig(configFile);
  const lease = await SingletonLease.acquire(paths.lockFile, config.commands.flock);
  const stateStore = new PrStateStore(paths, lease);
  const started = Date.now();
  const correlationId = randomUUID();
  try {
    await stateStore.recover();
    const identity = new GithubAppIdentity(config);
    const token = await identity.mintInstallationToken();
    const actor = await identity.verify(token);
    const pullRequests = await new GithubDiscovery(config, token).listOpenPullRequests();
    const states = new Map<number, PrState>();
    for (const pr of pullRequests) {
      const previous = await stateStore.read(pr.number);
      if (previous !== undefined) states.set(pr.number, previous);
    }
    const candidates = selectReviewCandidates(pullRequests, states, config.rubricVersion);
    for (const pr of pullRequests) {
      const previous = states.get(pr.number);
      const next = previous === undefined ? initialState(pr, config) : observedState(pr, previous);
      if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(next)) await stateStore.write(next);
    }
    const events = new EventLog(paths, lease);
    const now = new Date().toISOString();
    await events.append({
      timestamp: now,
      type: "poll",
      pr: null,
      headSha: null,
      rubricVersion: config.rubricVersion,
      actor,
      durationMs: Date.now() - started,
      correlationId,
      detail: { openPullRequests: pullRequests.length, candidates: candidates.length },
    });
    for (const candidate of candidates) {
      await events.append({
        timestamp: now,
        type: "selection",
        pr: candidate.number,
        headSha: candidate.headSha,
        rubricVersion: config.rubricVersion,
        actor,
        durationMs: 0,
        correlationId,
        detail: { reason: states.has(candidate.number) ? "changed_or_invalidated" : "new" },
      });
    }
    return { actor, openPullRequests: pullRequests.length, candidates };
  } finally {
    await lease.release();
  }
}
