import { describe, expect, it } from "vitest";
import type { ReviewAnswer } from "../src/engine/answerers/schemas/index.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { ReviewApprovedPayload } from "../src/engine/events/schemas/reviewForgeReceipt.js";
import { evaluateExactReviewReceiptHead } from "../src/engine/merge/landSignals.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import type { GitHubHttpClient, GitHubHttpRequest } from "../src/engine/providers/github.js";
import type { ReviewMergeRunContext } from "../src/engine/workflow/reviewMerge/context.js";
import { buildGitHubReviewProbe, type ReviewProbe } from "../src/engine/workflow/reviewMerge/reviewProbeGithub.js";
import { InMemorySimulatedReviewIntentRepository } from "../src/engine/workflow/reviewMerge/simulatedReviewIntent.js";
import {
  reconcileExistingSimulatedReviews,
  simulatedReviewIntentFingerprint,
  simulatedReviewIntentMarker,
  SimulatedReviewHeadStaleError,
  strictReviewEventFor,
  tanrenSimulatedReviewMarker,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";
import { InMemorySimulatedReviewPublishFence } from "../src/engine/workflow/reviewMerge/simulatedReviewPublishFence.js";
import { runSimulatedReviewStage } from "../src/engine/workflow/reviewMerge/simulatedReviewStage.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const REVIEWER = "reviewer-bot";
const context: ReviewMergeRunContext = {
  runId: "run_gv2",
  specId: "spec_gv2",
  projectId: "project_gv2",
  orgId: "org_gv2",
  prUrl: "https://github.com/o/r/pull/1",
  baseBranch: "main",
  headBranch: "feat",
  mergeIntegration: "native_queue",
  governancePosture: "open",
  policyVersion: 1,
  policyIdentity: "policy-sha256:test-gv2",
  reviewPolicy: "simulated",
  tanrenLogins: ["tanren[bot]"],
  platformLogins: [],
  staticCredentialRef: "credential/github/org/org_gv2/writer",
};

function reviewer(seen: { calls: number }): AnswererAdapter<ReviewAnswer> {
  return {
    kind: "answerer",
    cli: "test",
    authRef: "test",
    runAnswerer: async () => {
      seen.calls += 1;
      return { verdict: "approve", reasoning: "all criteria met" };
    },
  };
}

function probe(input: { author: string; liveHead: string; posts: { count: number } }): ReviewProbe {
  return {
    markReady: async () => {},
    fetchVerdict: async () => ({ verdict: "pending" }),
    fetchSnapshot: async () => ({
      baseSha: HEAD_B,
      headSha: HEAD_A,
      authorLogin: input.author,
      diff: "diff --git a/x b/x\n+x",
    }),
    fetchLiveHeadSha: async () => input.liveHead,
    pinSimulatedReviewer: async () => ({
      reviewerLogin: REVIEWER,
      submitReview: async () => {
        input.posts.count += 1;
        return {
          forgeReviewId: "7",
          forgeReviewState: "approved",
          forgeReviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-7",
          headSha: HEAD_A,
          reviewerLogin: REVIEWER,
        };
      },
    }),
  };
}

async function drive(testProbe: ReviewProbe, seen: { calls: number }) {
  return runSimulatedReviewStage({
    context,
    probe: testProbe,
    taskId: "task_review",
    pullNumber: 1,
    resolveReviewer: () => reviewer(seen),
    spec: { specTitle: "Strict review", specDescription: "publish honestly", acceptanceCriteria: ["exact head"] },
    intentRepository: new InMemorySimulatedReviewIntentRepository(),
    publishFence: new InMemorySimulatedReviewPublishFence(),
    repo: { owner: "o", name: "r" },
  });
}

describe("GV2-STRICT-FORGE-EXACT-HEAD", () => {
  it("production snapshot performs one PR metadata read, then diffs immutable base/head SHAs", async () => {
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/org/org_gv2/writer", token: "ghp_writer" });
    const requests: GitHubHttpRequest[] = [];
    const http: GitHubHttpClient = {
      request: async (request) => {
        requests.push(request);
        if (request.path.endsWith("/pulls/1")) {
          return {
            status: 200,
            body: { base: { sha: HEAD_B }, head: { sha: HEAD_A }, user: { login: "pr-writer" } },
          };
        }
        if (request.path.includes(`/compare/${HEAD_B}...${HEAD_A}`)) {
          return { status: 200, body: { files: [{ filename: "x.ts", patch: "+x" }] } };
        }
        throw new Error(`unexpected ${request.method} ${request.path}`);
      },
    };
    const productionProbe = await buildGitHubReviewProbe({
      secrets,
      githubHttp: http,
      context,
      repo: { owner: "o", name: "r" },
      pullNumber: 1,
    });
    const snapshot = await productionProbe.fetchSnapshot!();
    expect(snapshot).toEqual({
      baseSha: HEAD_B,
      headSha: HEAD_A,
      authorLogin: "pr-writer",
      diff: "diff --git x.ts\n+x",
    });
    expect(requests.filter((request) => request.path.endsWith("/pulls/1"))).toHaveLength(1);
    expect(requests.map((request) => request.path)).toEqual([
      "/repos/o/r/pulls/1",
      `/repos/o/r/compare/${HEAD_B}...${HEAD_A}`,
    ]);
  });

  it("production re-lists under the fence, then revalidates head immediately before zero-POST", async () => {
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/org/org_gv2/writer", token: "ghp_writer" });
    await storeGithubToken(secrets, { ref: "credential/github/org/org_gv2/reviewer", token: "ghp_reviewer" });
    const requests: GitHubHttpRequest[] = [];
    const http: GitHubHttpClient = {
      request: async (request) => {
        requests.push(request);
        if (request.path === "/user") {
          return {
            status: 200,
            body: { login: request.token === "ghp_writer" ? "pr-writer" : REVIEWER, id: 1 },
          };
        }
        if (request.path.includes("/reviews?")) return { status: 200, body: [] };
        if (request.path.endsWith("/pulls/1")) {
          return {
            status: 200,
            body: { base: { sha: HEAD_A }, head: { sha: HEAD_B }, user: { login: "pr-writer" } },
          };
        }
        if (request.method === "POST") throw new Error("POST must not run after head drift");
        throw new Error(`unexpected ${request.method} ${request.path}`);
      },
    };
    const productionProbe = await buildGitHubReviewProbe({
      secrets,
      githubHttp: http,
      reviewerGithubCredentialRef: "credential/github/org/org_gv2/reviewer",
      context,
      repo: { owner: "o", name: "r" },
      pullNumber: 1,
    });
    const intentMarker = simulatedReviewIntentMarker("1".repeat(64));
    const pinnedReviewer = await productionProbe.pinSimulatedReviewer!();
    await expect(
      pinnedReviewer.submitReview("APPROVE", `${tanrenSimulatedReviewMarker("approved")}\n${intentMarker}`, HEAD_A),
    ).rejects.toBeInstanceOf(SimulatedReviewHeadStaleError);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
    expect(requests.at(-2)?.path).toContain("/reviews?");
    expect(requests.at(-1)?.path).toBe("/repos/o/r/pulls/1");
  });

  it("uses one coherent snapshot and revalidates live head inside the fence before zero-POST stale redrive", async () => {
    const posts = { count: 0 };
    await expect(drive(probe({ author: "writer", liveHead: HEAD_B, posts }), { calls: 0 })).rejects.toBeInstanceOf(
      SimulatedReviewHeadStaleError,
    );
    expect(posts.count).toBe(0);
  });

  it("rejects provider-observed PR-author self-review before publication", async () => {
    const posts = { count: 0 };
    const seen = { calls: 0 };
    await expect(drive(probe({ author: REVIEWER, liveHead: HEAD_A, posts }), seen)).rejects.toThrow(/self-review/iu);
    expect(seen.calls).toBe(0);
    expect(posts.count).toBe(0);
  });

  it("never maps simulated verdicts to COMMENT and rejects partial terminal receipts", () => {
    expect(strictReviewEventFor("approve")).toBe("APPROVE");
    expect(strictReviewEventFor("request_changes")).toBe("REQUEST_CHANGES");
    expect(
      ReviewApprovedPayload.safeParse({
        prUrl: "https://github.com/o/r/pull/1",
        prNumber: 1,
        reviewer: REVIEWER,
        forgeReviewId: "7",
      }).success,
    ).toBe(false);
  });

  it("does not reclaim another run's same-state/head/login review", () => {
    const fingerprint = (runId: string) =>
      simulatedReviewIntentMarker(
        simulatedReviewIntentFingerprint({
          runId,
          taskId: "task_review",
          headSha: HEAD_A,
          state: "approved",
          reviewerLogin: REVIEWER,
          message: "ok",
        }),
      );
    const priorBody = `${tanrenSimulatedReviewMarker("approved")}\n${fingerprint("run_prior")}`;
    expect(
      reconcileExistingSimulatedReviews({
        reviews: [
          {
            forgeReviewId: "7",
            state: "approved",
            forgeReviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-7",
            headSha: HEAD_A,
            reviewerLogin: REVIEWER,
            body: priorBody,
          },
        ],
        expectedState: "approved",
        expectedHeadSha: HEAD_A,
        expectedReviewerLogin: REVIEWER,
        expectedIntentMarker: fingerprint("run_current"),
      }),
    ).toEqual({ kind: "absent" });
  });

  it("shared receipt guard blocks missing simulated proof and head A→B, then admits exact B", () => {
    expect(
      evaluateExactReviewReceiptHead({
        reviewVerdict: "approved",
        reviewedHeadSha: undefined,
        landingHeadSha: HEAD_B,
        receiptRequired: true,
      }),
    ).toMatchObject({ kind: "blocked", reasonCode: "receipt_missing" });
    expect(
      evaluateExactReviewReceiptHead({
        reviewVerdict: "approved",
        reviewedHeadSha: HEAD_A,
        landingHeadSha: HEAD_B,
        receiptRequired: true,
      }),
    ).toMatchObject({ kind: "blocked", reasonCode: "receipt_head_mismatch" });
    expect(
      evaluateExactReviewReceiptHead({
        reviewVerdict: "approved",
        reviewedHeadSha: HEAD_B,
        landingHeadSha: HEAD_B,
        receiptRequired: true,
      }),
    ).toEqual({ kind: "matched" });
  });
});
