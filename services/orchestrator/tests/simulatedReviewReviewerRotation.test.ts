// gv-2 reviewer-rotation mutation gate. The production probe must pin one
// attempt-scoped reviewer credential/login before durable intent resolution;
// the same capability is then the only authority allowed to list or POST.

import { describe, expect, it } from "vitest";

import type { ReviewAnswer } from "../src/engine/answerers/schemas/index.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import {
  FetchGitHubHttpClient,
  type GitHubHttpClient,
  type GitHubHttpRequest,
} from "../src/engine/providers/github.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import type { ReviewMergeRunContext } from "../src/engine/workflow/reviewMerge/context.js";
import { buildGitHubReviewProbe } from "../src/engine/workflow/reviewMerge/reviewProbeGithub.js";
import {
  InMemorySimulatedReviewIntentRepository,
  type SimulatedReviewIntent,
} from "../src/engine/workflow/reviewMerge/simulatedReviewIntent.js";
import {
  simulatedReviewIntentFingerprint,
  simulatedReviewIntentMarker,
  SimulatedReviewPublicationError,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";
import { pollReviewForRun } from "../src/engine/workflow/reviewMerge/reviewPolling.js";
import type { SimulatedReviewPublishFence } from "../src/engine/workflow/reviewMerge/simulatedReviewPublishFence.js";
import { runSimulatedReviewStage } from "../src/engine/workflow/reviewMerge/simulatedReviewStage.js";
import { reviewBodyFor } from "../src/engine/workflow/reviewMerge/simulatedReviewer.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { fakeMergeWriter, ReviewMergePool } from "./reviewMerge.fixtures.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const WRITER_REF = "credential/github/org/org_rotation/writer";
const REVIEWER_REF = "credential/github/org/org_rotation/reviewer";
const WRITER_TOKEN = "ghp_writer";
const REVIEWER_A_TOKEN = "ghp_reviewer_a";
const REVIEWER_B_TOKEN = "ghp_reviewer_b";
const REVIEWER_A = "ReviewerBot";
const REVIEWER_B = "RotatedBot";
const TASK_ID = "task_review";

const context: ReviewMergeRunContext = {
  runId: "run_rotation",
  specId: "spec_rotation",
  projectId: "project_rotation",
  orgId: "org_rotation",
  prUrl: "https://github.com/o/r/pull/1",
  baseBranch: "main",
  headBranch: "feat",
  mergeIntegration: "direct_merge",
  governancePosture: "open",
  policyVersion: 1,
  reviewPolicy: "simulated",
  tanrenLogins: ["writer-bot"],
  platformLogins: [],
  staticCredentialRef: WRITER_REF,
};

class CountingSecretStore extends FakeSecretStore {
  reviewerReads = 0;

  override async get(ref: string) {
    if (ref === REVIEWER_REF) this.reviewerReads += 1;
    return super.get(ref);
  }
}

interface HttpCounters {
  lists: number;
  posts: number;
  listTokens: string[];
  postTokens: string[];
}

interface AuthFailureTrace {
  listTokens: string[];
  postTokens: string[];
  successfulPosts: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function retryAwareProductionHttp(
  failure: { phase: "list" | "post"; status: 401 | 403 },
  trace: AuthFailureTrace,
): GitHubHttpClient {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const requestUrl = new URL(url);
    const path = `${requestUrl.pathname}${requestUrl.search}`;
    const authorization = String((init.headers as Record<string, string>).Authorization);
    const token = authorization.replace(/^Bearer /u, "");

    if (path === "/user") {
      const login = token === WRITER_TOKEN ? "pr-writer" : token === REVIEWER_A_TOKEN ? REVIEWER_A : REVIEWER_B;
      return jsonResponse({ login, id: 7 });
    }
    if (path.includes(`/compare/${BASE}...${HEAD}`)) {
      return jsonResponse({ files: [{ filename: "x.ts", patch: "+x" }] });
    }
    if (path.includes("/reviews?")) {
      trace.listTokens.push(token);
      if (failure.phase === "list" && token === REVIEWER_A_TOKEN) {
        return jsonResponse({ message: "reviewer credential rejected" }, failure.status);
      }
      return jsonResponse([]);
    }
    if (init.method === "POST" && path.endsWith("/reviews")) {
      trace.postTokens.push(token);
      if (failure.phase === "post" && token === REVIEWER_A_TOKEN) {
        return jsonResponse({ message: "reviewer credential rejected" }, failure.status);
      }
      trace.successfulPosts += 1;
      return jsonResponse({
        id: 91,
        state: "APPROVED",
        html_url: "https://github.com/o/r/pull/1#pullrequestreview-91",
        commit_id: HEAD,
        user: { login: token === REVIEWER_A_TOKEN ? REVIEWER_A : REVIEWER_B },
      });
    }
    if (path.endsWith("/pulls/1")) {
      return jsonResponse({ base: { sha: BASE }, head: { sha: HEAD }, user: { login: "pr-writer" } });
    }
    throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
  }) as unknown as typeof fetch;

  return new FetchGitHubHttpClient({ fetchImpl, sleep: async () => {} });
}

function productionHttp(counters: HttpCounters): GitHubHttpClient {
  return {
    request: async (request: GitHubHttpRequest) => {
      if (request.path === "/user") {
        const login =
          request.token === WRITER_TOKEN ? "pr-writer" : request.token === REVIEWER_A_TOKEN ? REVIEWER_A : REVIEWER_B;
        return { status: 200, body: { login, id: 7 } };
      }
      if (request.path.includes(`/compare/${BASE}...${HEAD}`)) {
        return { status: 200, body: { files: [{ filename: "x.ts", patch: "+x" }] } };
      }
      if (request.path.includes("/reviews?")) {
        counters.lists += 1;
        counters.listTokens.push(request.token);
        return { status: 200, body: [] };
      }
      if (request.method === "POST" && request.path.endsWith("/reviews")) {
        counters.posts += 1;
        counters.postTokens.push(request.token);
        return {
          status: 200,
          body: {
            id: 91,
            state: "APPROVED",
            html_url: "https://github.com/o/r/pull/1#pullrequestreview-91",
            commit_id: HEAD,
            user: { login: REVIEWER_A.toLowerCase() },
          },
        };
      }
      if (request.path.endsWith("/pulls/1")) {
        return {
          status: 200,
          body: { base: { sha: BASE }, head: { sha: HEAD }, user: { login: "pr-writer" } },
        };
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    },
  };
}

function storedIntent(reviewerLogin: string, binding: { runId?: string; taskId?: string } = {}): SimulatedReviewIntent {
  const message = "durable approval";
  const marker = simulatedReviewIntentMarker(
    simulatedReviewIntentFingerprint({
      runId: binding.runId ?? context.runId,
      taskId: binding.taskId ?? TASK_ID,
      headSha: HEAD,
      state: "approved",
      reviewerLogin,
      message,
    }),
  );
  return {
    headSha: HEAD,
    state: "approved",
    event: "APPROVE",
    body: `${reviewBodyFor({ verdict: "approve", reasoning: message })}\n\n${marker}`,
    message,
    reviewerLogin,
    marker: "tanren-simulated-review:v1:approved",
  };
}

function reviewer(answererCalls: { count: number }): AnswererAdapter<ReviewAnswer> {
  return {
    kind: "answerer",
    cli: "test",
    authRef: "test",
    runAnswerer: async () => {
      answererCalls.count += 1;
      return { verdict: "approve", reasoning: "durable approval" };
    },
  };
}

async function seedSecrets(reviewerToken: string): Promise<CountingSecretStore> {
  const secrets = new CountingSecretStore();
  await storeGithubToken(secrets, { ref: WRITER_REF, token: WRITER_TOKEN });
  await storeGithubToken(secrets, { ref: REVIEWER_REF, token: reviewerToken });
  return secrets;
}

async function buildProbe(secrets: CountingSecretStore, counters: HttpCounters) {
  return buildGitHubReviewProbe({
    secrets,
    githubHttp: productionHttp(counters),
    reviewerGithubCredentialRef: REVIEWER_REF,
    context,
    repo: { owner: "o", name: "r" },
    pullNumber: 1,
  });
}

function stageInput(
  probe: Awaited<ReturnType<typeof buildProbe>>,
  intentRepository: InMemorySimulatedReviewIntentRepository,
  publishFence: SimulatedReviewPublishFence,
  answererCalls: { count: number },
) {
  return {
    context,
    probe,
    taskId: TASK_ID,
    pullNumber: 1,
    resolveReviewer: () => reviewer(answererCalls),
    spec: { specTitle: "Review", specDescription: "pin credentials", acceptanceCriteria: ["one pin"] },
    intentRepository,
    publishFence,
    repo: { owner: "o", name: "r" },
  };
}

describe("gv-2 attempt-scoped simulated-reviewer pin", () => {
  it("rejects durable intent A vs current credential B before Answerer, fence, list, POST, receipt, or terminal event", async () => {
    const secrets = await seedSecrets(REVIEWER_B_TOKEN);
    const counters: HttpCounters = { lists: 0, posts: 0, listTokens: [], postTokens: [] };
    const probe = await buildProbe(secrets, counters);
    const intents = new InMemorySimulatedReviewIntentRepository();
    intents.seed("run_1", storedIntent(REVIEWER_A, { runId: "run_1", taskId: TASK_ID }));
    const answererCalls = { count: 0 };
    const fenceCalls = { count: 0 };
    const fence: SimulatedReviewPublishFence = {
      withExclusivePublish: async () => {
        fenceCalls.count += 1;
        throw new Error("publish fence must not be entered after reviewer rotation");
      },
    };
    const pool = new ReviewMergePool("direct_merge", "open", "simulated");
    pool.tasks.push({ task_id: TASK_ID, run_id: "run_1", kind: "review", status: "running" });
    const events = new FakeEventStore();

    let failure: unknown;
    try {
      await pollReviewForRun({
        pool: pool.asPgPool(),
        eventStore: events,
        runStateWriter: fakeMergeWriter(pool, events),
        secrets,
        githubHttp: productionHttp(counters),
        runId: "run_1",
        reviewProbe: probe,
        simulatedReviewer: () => reviewer(answererCalls),
        simulatedReviewContext: {
          specTitle: "Review",
          specDescription: "pin credentials",
          acceptanceCriteria: ["one pin"],
        },
        intentRepository: intents,
        publishFence: fence,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SimulatedReviewPublicationError);
    expect((failure as SimulatedReviewPublicationError).message).toMatch(/credential mismatch before publication/iu);
    expect((failure as SimulatedReviewPublicationError).retriable).toBe(false);
    expect(answererCalls.count).toBe(0);
    expect(fenceCalls.count).toBe(0);
    expect(counters.lists).toBe(0);
    expect(counters.posts).toBe(0);
    expect(secrets.reviewerReads).toBe(1);
    const eventTypes = events.events.map((event) => event.eventType);
    expect(eventTypes).toContain("review.requested");
    expect(eventTypes).not.toContain("review.approved");
    expect(eventTypes).not.toContain("review.changes_requested");
    expect(eventTypes).not.toContain("task.completed");
  });

  it("uses one pinned token across Answerer, fence, reconcile, and POST despite mid-attempt secret rotation", async () => {
    const secrets = await seedSecrets(REVIEWER_A_TOKEN);
    const counters: HttpCounters = { lists: 0, posts: 0, listTokens: [], postTokens: [] };
    const probe = await buildProbe(secrets, counters);
    const intents = new InMemorySimulatedReviewIntentRepository();
    const answererCalls = { count: 0 };
    const fenceCalls = { count: 0 };
    const fence: SimulatedReviewPublishFence = {
      withExclusivePublish: async (_key, work) => {
        fenceCalls.count += 1;
        await storeGithubToken(secrets, { ref: REVIEWER_REF, token: REVIEWER_B_TOKEN });
        return work();
      },
    };

    const result = await runSimulatedReviewStage(stageInput(probe, intents, fence, answererCalls));

    expect(result.verdict).toBe("approved");
    expect(result.intent.reviewerLogin).toBe(REVIEWER_A);
    expect(result.forgePublication.reviewerLogin).toBe(REVIEWER_A.toLowerCase());
    expect(answererCalls.count).toBe(1);
    expect(fenceCalls.count).toBe(1);
    expect(secrets.reviewerReads).toBe(1);
    expect(counters.lists).toBe(1);
    expect(counters.posts).toBe(1);
    expect(counters.listTokens).toEqual([REVIEWER_A_TOKEN]);
    expect(counters.postTokens).toEqual([REVIEWER_A_TOKEN]);
  });

  it.each([
    ["list", 401],
    ["list", 403],
    ["post", 401],
    ["post", 403],
  ] as const)("never refreshes pinned reviewer A to rotated B when %s returns %i", async (phase, status) => {
    const secrets = await seedSecrets(REVIEWER_A_TOKEN);
    const trace: AuthFailureTrace = { listTokens: [], postTokens: [], successfulPosts: 0 };
    const githubHttp = retryAwareProductionHttp({ phase, status }, trace);
    const productionProbe = await buildGitHubReviewProbe({
      secrets,
      githubHttp,
      reviewerGithubCredentialRef: REVIEWER_REF,
      context,
      repo: { owner: "o", name: "r" },
      pullNumber: 1,
    });
    const probe = {
      ...productionProbe,
      markReady: async () => {},
      fetchVerdict: async () => ({ verdict: "pending" as const }),
    };
    const intents = new InMemorySimulatedReviewIntentRepository();
    const answererCalls = { count: 0 };
    const fence: SimulatedReviewPublishFence = {
      withExclusivePublish: async (_key, work) => {
        await storeGithubToken(secrets, { ref: REVIEWER_REF, token: REVIEWER_B_TOKEN });
        return work();
      },
    };
    const pool = new ReviewMergePool("direct_merge", "open", "simulated");
    const events = new FakeEventStore();

    await expect(
      pollReviewForRun({
        pool: pool.asPgPool(),
        eventStore: events,
        runStateWriter: fakeMergeWriter(pool, events),
        secrets,
        githubHttp,
        runId: "run_1",
        reviewProbe: probe,
        simulatedReviewer: () => reviewer(answererCalls),
        simulatedReviewContext: {
          specTitle: "Review",
          specDescription: "freeze static reviewer credentials",
          acceptanceCriteria: ["no credential refresh within one attempt"],
        },
        intentRepository: intents,
        publishFence: fence,
      }),
    ).rejects.toBeInstanceOf(SimulatedReviewPublicationError);

    expect(answererCalls.count).toBe(1);
    expect(secrets.reviewerReads).toBe(1);
    // A failed POST is followed by the normal response-loss reconcile read;
    // both reads stay on the immutable A snapshot and no second POST occurs.
    expect(trace.listTokens).toEqual(phase === "post" ? [REVIEWER_A_TOKEN, REVIEWER_A_TOKEN] : [REVIEWER_A_TOKEN]);
    expect(trace.postTokens).toEqual(phase === "post" ? [REVIEWER_A_TOKEN] : []);
    expect(trace.successfulPosts).toBe(0);
    expect([...trace.listTokens, ...trace.postTokens]).not.toContain(REVIEWER_B_TOKEN);
    const eventTypes = events.events.map((event) => event.eventType);
    expect(eventTypes).not.toContain("review.approved");
    expect(eventTypes).not.toContain("review.changes_requested");
    expect(eventTypes).not.toContain("task.completed");
  });
});
