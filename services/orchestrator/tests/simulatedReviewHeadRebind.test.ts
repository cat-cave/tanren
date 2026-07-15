// gv-2 former-bug recovery proof (production-composed, no DB):
//
// review head A → head advances to B → re-review B must durably supersede the
// authoritative receipt used for landing. Same-head retry remains idempotent.
// A never authorizes B; landing B succeeds only from B's receipt.
//
// Composition under test (one authority / one event stream — no second store):
//   markReviewTaskDoneWithEvent  → head-bound idempotency key + forge receipt
//   InMemoryRunStateWriter       → first-wins on (runId, idempotencyKey)
//   authorizeAndLand             → exact-head review receipt bind

import { describe, expect, it } from "vitest";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";
import { authorizeAndLand } from "../src/engine/merge/mergeAuthorityGate.js";
import type { AuthorityLandStore } from "../src/engine/merge/mergeAuthorityV2Impl.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import type { AuditPosture } from "../src/engine/contracts/auditPosture.js";
import { markReviewTaskDoneWithEvent } from "../src/engine/workflow/reviewMerge/reviewTaskTerminal.js";
import type { ForgeReviewPublication } from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";

const REPO = { owner: "o", name: "r" };
const POSTURE: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag" };
const STORE: AuthorityLandStore = {
  persistAuthorizedDecision: async () => ({ effectIntentId: "intent_1" }),
  recordLandReceipt: async () => ({ auditId: "a1" }),
};

const RUN_ID = "run_rebind";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function forgeReceipt(headSha: string, reviewId: string): ForgeReviewPublication {
  return {
    forgeReviewId: reviewId,
    forgeReviewState: "approved",
    forgeReviewUrl: `https://github.com/o/r/pull/1#pullrequestreview-${reviewId}`,
    headSha,
    reviewerLogin: "reviewer-bot",
  };
}

/**
 * Mirror landSignals.resolveLandTimeSignals LATEST selection over the durable
 * event timeline the terminal writer produced (ORDER BY ts DESC, id DESC).
 */
function latestReviewedHeadSha(writer: InMemoryRunStateWriter): string | undefined {
  const reviews = writer.allEvents.filter(
    (e) => e.eventType === "review.approved" || e.eventType === "review.changes_requested",
  );
  const latest = reviews.at(-1);
  if (latest === undefined) return undefined;
  const headSha = (latest.payload as { headSha?: string }).headSha;
  return typeof headSha === "string" && headSha !== "" ? headSha : undefined;
}

function landInput(host: InMemoryCodeHost, landingHead: string, reviewedHeadSha: string | undefined) {
  return {
    codeHost: host,
    repo: REPO,
    intoMain: "main",
    headBranch: "feat",
    runId: RUN_ID,
    specId: "spec_rebind",
    gateConfigHash: "gc",
    policyVersion: "pv",
    gatedHeadSha: landingHead,
    reviewedHeadSha,
    store: STORE,
    signals: {
      gateOutcome: { passed: true, results: [] } as GateOutcome,
      findings: [],
      auditPosture: POSTURE,
      reviewVerdict: "approved" as const,
      mergeability: { state: "clean" as const, behind: false, baseBranch: "main", headBranch: "feat" },
      budget: { ceilingUsd: undefined, spentUsd: 0 },
      demo: "not_required" as const,
      hitlSignoff: "not_required" as const,
      conflictsResolved: true,
    },
  };
}

describe("gv-2 simulated review head rebind (former bug: first-wins blocked re-review)", () => {
  it("review A → head advances to B → re-review B supersedes; land B only from B's receipt", async () => {
    const writer = new InMemoryRunStateWriter();
    const baseA = {
      runId: RUN_ID,
      specId: "spec_rebind",
      projectId: "proj_rebind",
      orgId: "org_rebind",
      taskId: "task_review_A",
    };
    const baseB = { ...baseA, taskId: "task_review_B" };

    // 1. Strict simulated review terminalizes on head A with forge receipt A.
    await markReviewTaskDoneWithEvent({
      writer,
      base: baseA,
      verdict: "approved",
      prUrl: "https://github.com/o/r/pull/1",
      prNumber: 1,
      forgePublication: forgeReceipt(HEAD_A, "100"),
    });
    expect(latestReviewedHeadSha(writer)).toBe(HEAD_A);
    const keyA = `${RUN_ID}:review:approved:${HEAD_A}`;
    expect(writer.allEvents.some((e) => e.eventType === "review.approved" && e.idempotencyKey === keyA)).toBe(true);

    // 2. Head advanced to B: landing B with A's receipt must fail closed.
    const hostBlocked = new InMemoryCodeHost();
    hostBlocked.seed(REPO, "main", "sha-main");
    await hostBlocked.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: HEAD_B });
    const blocked = await authorizeAndLand(landInput(hostBlocked, HEAD_B, HEAD_A));
    expect(blocked.kind).toBe("blocked");
    expect(await hostBlocked.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");

    // 3. Re-review on replacement head B — distinct head-bound key, new durable receipt.
    await markReviewTaskDoneWithEvent({
      writer,
      base: baseB,
      verdict: "approved",
      prUrl: "https://github.com/o/r/pull/1",
      prNumber: 1,
      forgePublication: forgeReceipt(HEAD_B, "200"),
    });
    const keyB = `${RUN_ID}:review:approved:${HEAD_B}`;
    expect(keyA).not.toBe(keyB);
    const approved = writer.allEvents.filter((e) => e.eventType === "review.approved");
    expect(approved).toHaveLength(2);
    expect(approved.map((e) => (e.payload as { headSha: string }).headSha)).toEqual([HEAD_A, HEAD_B]);
    expect(approved.map((e) => e.idempotencyKey)).toEqual([keyA, keyB]);
    // Land signals take LATEST — B supersedes A as the authoritative receipt.
    expect(latestReviewedHeadSha(writer)).toBe(HEAD_B);

    // 4. Landing B succeeds only from B's receipt (not A's).
    const hostLand = new InMemoryCodeHost();
    hostLand.seed(REPO, "main", "sha-main");
    await hostLand.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: HEAD_B });
    const stillBlockedFromA = await authorizeAndLand(landInput(hostLand, HEAD_B, HEAD_A));
    expect(stillBlockedFromA.kind).toBe("blocked");
    expect(await hostLand.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");

    const landed = await authorizeAndLand(landInput(hostLand, HEAD_B, HEAD_B));
    expect(landed.kind).toBe("merged");
    expect(await hostLand.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe(HEAD_B);
  });

  it("same-head re-publish of approved remains first-wins idempotent (retry does not double-emit)", async () => {
    const writer = new InMemoryRunStateWriter();
    const base = {
      runId: RUN_ID,
      specId: "spec_rebind",
      projectId: "proj_rebind",
      orgId: "org_rebind",
      taskId: "task_review_retry",
    };
    const receipt = forgeReceipt(HEAD_A, "100");
    const publish = () =>
      markReviewTaskDoneWithEvent({
        writer,
        base,
        verdict: "approved",
        prUrl: "https://github.com/o/r/pull/1",
        prNumber: 1,
        forgePublication: receipt,
      });

    await publish();
    // Retry of the same finalize (same head + same key).
    await publish();

    const approved = writer.allEvents.filter((e) => e.eventType === "review.approved");
    expect(approved).toHaveLength(1);
    expect((approved[0]!.payload as { forgeReviewId: string }).forgeReviewId).toBe("100");
    expect(approved[0]!.idempotencyKey).toBe(`${RUN_ID}:review:approved:${HEAD_A}`);
  });
});
