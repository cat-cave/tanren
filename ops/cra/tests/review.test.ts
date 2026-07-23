import { afterEach, describe, expect, it } from "vitest";
import type { DiscoveredReview } from "../src/discovery.js";
import { OfficialReviewPoster } from "../src/officialReview.js";
import { buildReviewMarker } from "../src/reviewMarker.js";
import { reviewOnce } from "../src/reviewOnce.js";
import { triage } from "../src/triage.js";
import type { PrState } from "../src/stateSchemas.js";
import { firstSha, secondSha, testConfig } from "./helpers.js";
import {
  auditContext,
  cleanEvidence,
  stubAssembler,
  throwingAssembler,
  validReport,
  verifiedWorktree,
} from "./auditFixtures.js";
import { ghSpy, reviewDeps, reviewMarkerKey, stateFixture } from "./reviewHelpers.js";

const roots: string[] = [];

function initialState(): PrState {
  return {
    pr: 1240,
    lastSeenHeadSha: firstSha,
    lastReviewedHeadSha: null,
    lastReviewedBaseSha: null,
    auditedIssueNumber: null,
    rubricVersion: "2026-07-22",
    reviewId: null,
    findingIds: [],
    disposition: "pending",
    firstAuthorActivityAt: "2026-07-20T00:00:00.000Z",
    lastAuthorActivityAt: "2026-07-21T00:00:00.000Z",
    awaitingAuthorSince: null,
    retry: { attempts: 0, nextAttemptAt: null, lastError: null },
    followUpIssues: [],
    auditStatus: "idle",
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

const verifiedBase = {
  independence: { confirmed: true, reason: "cross-model" },
  sandbox: { ran: true, passed: true, detail: "exit 0" },
  headSha: firstSha,
  baseSha: secondSha,
  rubricVersion: "2026-07-22",
} as const;

const evidence = cleanEvidence();

describe("official GitHub review poster", () => {
  it("posts exactly one review bound to the audited head with inline + summary findings", async () => {
    const executor = ghSpy("CHANGES_REQUESTED");
    const requestChanges = triage(
      {
        ...verifiedBase,
        report: validReport({
          findings: [
            {
              id: "loc",
              title: "boundary check missing",
              body: "add the guard",
              category: "correctness",
              concerns: "acceptance",
              suggestedSeverity: "P0",
              fixDirection: null,
              evidence: { path: "src/x.ts", line: 12, side: "RIGHT", commandRef: null, detail: "here" },
            },
          ],
        }),
      },
      evidence,
    );
    const result = await new OfficialReviewPoster(testConfig(), "token", executor).post(
      reviewMarkerKey,
      requestChanges,
      [],
    );
    expect(result).toMatchObject({ posted: true, reviewId: 5001, verdict: "REQUEST_CHANGES" });
    const request = executor.mock.calls[0]?.[0];
    const payload = JSON.parse(request?.input ?? "{}");
    expect(payload).toMatchObject({ commit_id: firstSha, event: "REQUEST_CHANGES" });
    expect(payload.body).toContain(buildReviewMarker(reviewMarkerKey));
    expect(payload.comments).toEqual([expect.objectContaining({ path: "src/x.ts", line: 12, side: "RIGHT" })]);
    expect(request?.args).toContain("/repos/cat-cave/tanren/pulls/1240/reviews");
  });

  it("no-ops when an existing bot review already carries the (pr, head, rubric) marker", async () => {
    const executor = ghSpy("APPROVED");
    const existing: DiscoveredReview[] = [
      {
        id: "PRR_1",
        databaseId: 4242,
        author: "trevor-workstation[bot]",
        state: "APPROVED",
        submittedAt: "2026-07-22T00:00:00.000Z",
        body: `${buildReviewMarker(reviewMarkerKey)}\nApproved.`,
        commitSha: firstSha,
      },
    ];
    const result = await new OfficialReviewPoster(testConfig(), "token", executor).post(
      reviewMarkerKey,
      triage({ ...verifiedBase, report: validReport() }, evidence),
      existing,
    );
    expect(result).toMatchObject({ posted: false, reviewId: 4242 });
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("reviewOnce fail-closed pipeline", () => {
  it("audits a clean PR, posts an APPROVE review, and persists the approved disposition", async () => {
    const { paths, lease, stateStore } = await stateFixture(roots);
    const gh = ghSpy("APPROVED");
    const result = await reviewOnce(reviewDeps(paths, lease, gh, JSON.stringify(validReport()), stubAssembler()), {
      state: initialState(),
      context: auditContext(),
      worktree: verifiedWorktree(),
      existingReviews: [],
      now: "2026-07-22T12:00:00.000Z",
    });
    expect(result).toMatchObject({ blocked: false, verdict: "APPROVE", posted: true, reviewId: 5001 });
    expect(await stateStore.read(1240)).toMatchObject({ disposition: "approved", auditedIssueNumber: 1244 });
    const artifact = await reviewDeps(
      paths,
      lease,
      gh,
      JSON.stringify(validReport()),
      stubAssembler(),
    ).artifactStore.readReport(1240, firstSha, "2026-07-22");
    expect(artifact.auditedIssueNumber).toBe(1244);
    expect(gh).toHaveBeenCalledOnce();
    await lease.release();
  });

  it("fails closed on a malformed report: no review posted, disposition error", async () => {
    const { paths, lease, stateStore } = await stateFixture(roots);
    const gh = ghSpy("APPROVED");
    const result = await reviewOnce(reviewDeps(paths, lease, gh, "this is not json", stubAssembler()), {
      state: initialState(),
      context: auditContext(),
      worktree: verifiedWorktree(),
      existingReviews: [],
      now: "2026-07-22T12:00:00.000Z",
    });
    expect(result.blocked).toBe(true);
    expect(result.verdict).toBeNull();
    expect(gh).not.toHaveBeenCalled();
    const persisted = await stateStore.read(1240);
    expect(persisted).toMatchObject({ disposition: "error", auditStatus: "failed" });
    expect(persisted?.lastReviewedHeadSha).toBeNull();
    await lease.release();
  });

  it("fails closed when the supervisor cannot assemble its own ground truth (no APPROVE on partial evidence)", async () => {
    const { paths, lease, stateStore } = await stateFixture(roots);
    const gh = ghSpy("APPROVED");
    const deps = reviewDeps(paths, lease, gh, JSON.stringify(validReport()), throwingAssembler("git diff failed"));
    const result = await reviewOnce(deps, {
      state: initialState(),
      context: auditContext(),
      worktree: verifiedWorktree(),
      existingReviews: [],
      now: "2026-07-22T12:00:00.000Z",
    });
    expect(result.blocked).toBe(true);
    expect(result.verdict).toBeNull();
    expect(gh).not.toHaveBeenCalled();
    expect((await stateStore.read(1240))?.disposition).toBe("error");
    await lease.release();
  });

  it("does not post a second review when re-polled on the same head (idempotent)", async () => {
    const { paths, lease } = await stateFixture(roots);
    const gh = ghSpy("APPROVED");
    const deps = reviewDeps(paths, lease, gh, JSON.stringify(validReport()), stubAssembler());
    const first = await reviewOnce(deps, {
      state: initialState(),
      context: auditContext(),
      worktree: verifiedWorktree(),
      existingReviews: [],
      now: "2026-07-22T12:00:00.000Z",
    });
    expect(first.posted).toBe(true);
    const priorReview: DiscoveredReview = {
      id: "PRR_1",
      databaseId: 5001,
      author: "trevor-workstation[bot]",
      state: "APPROVED",
      submittedAt: "2026-07-22T12:00:00.000Z",
      body: `${buildReviewMarker(reviewMarkerKey)}\nApproved.`,
      commitSha: firstSha,
    };
    const second = await reviewOnce(deps, {
      state: first.state,
      context: auditContext(),
      worktree: verifiedWorktree(),
      existingReviews: [priorReview],
      now: "2026-07-22T13:00:00.000Z",
    });
    expect(second.posted).toBe(false);
    expect(second.reviewId).toBe(5001);
    expect(gh).toHaveBeenCalledOnce();
    await lease.release();
  });

  it("promotes an immutable shadow audit to an official review without rerunning the model", async () => {
    const { paths, lease, stateStore } = await stateFixture(roots);
    const shadowDeps = reviewDeps(paths, lease, ghSpy("APPROVED"), JSON.stringify(validReport()), stubAssembler());
    const shadow = await reviewOnce(
      {
        ...shadowDeps,
        poster: {
          post: async (_key, triaged) => ({
            posted: false,
            reviewId: null,
            verdict: triaged.verdict,
          }),
        },
      },
      {
        state: initialState(),
        context: auditContext(),
        worktree: verifiedWorktree(),
        existingReviews: [],
        now: "2026-07-22T12:00:00.000Z",
      },
    );
    const promotedInput = { ...shadow.state, lastCompletedMode: "shadow" as const };
    await stateStore.write(promotedInput);
    const gh = ghSpy("APPROVED");
    const promoted = await reviewOnce(reviewDeps(paths, lease, gh, "model must not run again", stubAssembler()), {
      state: promotedInput,
      context: auditContext(),
      worktree: verifiedWorktree(),
      existingReviews: [],
      now: "2026-07-23T12:00:00.000Z",
    });
    expect(promoted).toMatchObject({ blocked: false, posted: true, reviewId: 5001, verdict: "APPROVE" });
    expect(gh).toHaveBeenCalledOnce();
    await lease.release();
  });
});
