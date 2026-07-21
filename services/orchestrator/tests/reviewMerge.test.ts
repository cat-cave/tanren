import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { reduceReviewVerdict } from "../src/engine/providers/githubReviewMerge.js";
import {
  assessExternalChange,
  decidePosture,
  dispatchedIntegrationFor,
  mergeForRun,
  reviewerRejection,
  tanrenIdentity,
  type ContributorProbe,
  type ReviewProbe,
} from "../src/engine/workflow/reviewMerge/index.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import { pollReviewForRun } from "../src/engine/workflow/reviewMerge/reviewPolling.js";
import {
  AUTHORITY_MAIN_SHA,
  AUTHORITY_REPO,
  FIXTURE_TANREN_LOGIN,
  ReviewMergePool,
  approvingReviewProbe,
  authorityBundle,
  authorityLand,
  fakeMergeWriter,
  recordingMergeProbe,
  tanrenSecrets,
  tanrenUserHttp,
  unusedHttp,
} from "./reviewMerge.fixtures.js";

describe("review verdict reduction", () => {
  it("changes_requested blocks even when a later approval exists from another reviewer", () => {
    expect(
      reduceReviewVerdict([
        { state: "approved", reviewer: "alice" },
        { state: "changes_requested", reviewer: "bob" },
      ]).verdict,
    ).toBe("changes_requested");
  });

  it("uses the latest review per reviewer", () => {
    expect(
      reduceReviewVerdict([
        { state: "changes_requested", reviewer: "bob" },
        { state: "approved", reviewer: "bob" },
        { state: "approved", reviewer: "alice" },
      ]).verdict,
    ).toBe("approved");
  });

  it("ignores comment/dismissed reviews and reports pending with none standing", () => {
    expect(reduceReviewVerdict([{ state: "commented", reviewer: "a" }]).verdict).toBe("pending");
    expect(reduceReviewVerdict([]).verdict).toBe("pending");
  });
});

describe("merge integration selection", () => {
  it("maps configured modes and treats not_configured as a hand-off", () => {
    expect(dispatchedIntegrationFor("native_queue")).toBe("native_queue");
    expect(dispatchedIntegrationFor("external_reviewer")).toBe("external_reviewer");
    expect(dispatchedIntegrationFor("not_configured")).toBe("external_reviewer");
  });
});

describe("review polling stage", () => {
  it("marks ready, emits review.requested + review.approved on approval", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    const probe = approvingReviewProbe();

    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
    });

    expect(result.verdict).toBe("approved");
    expect(probe.markedReady).toBe(true);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("github.pr.ready");
    expect(types).toContain("review.requested");
    expect(types).toContain("review.approved");
    expect(types).not.toContain("review.auto_approved");
    expect(pool.tasks.find((t) => t.kind === "review")?.status).toBe("done");
  });

  it("reviewPolicy: auto short-circuits to approved without polling GitHub, emits review.auto_approved", async () => {
    const pool = new ReviewMergePool("native_queue", "open", "auto");
    const events = new FakeEventStore();
    let markedReady = false;
    let fetched = false;
    const probe: ReviewProbe = {
      markReady: async () => {
        markedReady = true;
      },
      fetchVerdict: async () => {
        fetched = true;
        throw new Error("fetchVerdict must NOT be called when reviewPolicy is auto");
      },
    };

    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
    });

    expect(result.verdict).toBe("approved");
    expect(markedReady).toBe(true);
    expect(fetched).toBe(false);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("github.pr.ready");
    expect(types).toContain("review.requested");
    // The distinct auto marker AND the standard approved event (downstream consumers unchanged).
    expect(types).toContain("review.auto_approved");
    expect(types).toContain("review.approved");
    expect(pool.tasks.find((t) => t.kind === "review")?.status).toBe("done");
  });

  it("reviewPolicy: human (default) still polls GitHub for a verdict", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    let fetched = false;
    const probe: ReviewProbe = {
      markReady: async () => {},
      fetchVerdict: async () => {
        fetched = true;
        return { verdict: "approved", latest: { state: "approved", reviewer: "alice" } };
      },
    };

    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
    });

    expect(result.verdict).toBe("approved");
    expect(fetched).toBe(true);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("review.approved");
    expect(types).not.toContain("review.auto_approved");
  });

  it("emits review.changes_requested carrying the reviewer feedback as steering", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    const probe: ReviewProbe = {
      markReady: async () => {},
      fetchVerdict: async () => ({
        verdict: "changes_requested",
        latest: { state: "changes_requested", reviewer: "carol", body: "fix the edge case" },
      }),
    };

    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe,
    });

    expect(result.verdict).toBe("changes_requested");
    expect(result.feedback).toBe("fix the edge case");
    const changes = events.events.find((e) => e.eventType === "review.changes_requested");
    expect(changes?.payload).toMatchObject({ reviewer: "carol", message: "fix the edge case" });

    const rejection = reviewerRejection(result, "tanren/run_1");
    expect(rejection.producer).toBe("reviewer");
    expect(rejection.rejectionReason).toContain("fix the edge case");
    expect(rejection.rejectionReason).toContain("@carol");
  });
});

describe("merge dispatch stage", () => {
  it("native_queue drive without a persisted node/proof blocks before host land", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const { host, landed } = authorityLand();

    const result = await mergeForRun({
      queueDrive: true,
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed),
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: AUTHORITY_REPO, remoteBranch: "main" })).toBe(AUTHORITY_MAIN_SHA);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.queued");
    expect(types).toContain("merge.blocked");
    expect(types).not.toContain("merge.completed");
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("external_reviewer → hand-off, no land", async () => {
    const pool = new ReviewMergePool("external_reviewer");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const { host, landed } = authorityLand();

    const result = await mergeForRun({
      queueDrive: true,
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed),
    });

    expect(result.outcome).toBe("handed_off");
    // the hand-off path never lands: main untouched, nothing authorized.
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: AUTHORITY_REPO, remoteBranch: "main" })).toBe(AUTHORITY_MAIN_SHA);
    expect(events.events.find((e) => e.eventType === "merge.queued")?.payload).toMatchObject({
      integration: "external_reviewer",
    });
  });

  it("merge conflict → merge.conflict + recoverable (running) task, resolver hook invoked", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeability: { state: "behind", behind: true, baseBranch: "main", headBranch: "tanren/run_1" },
    });
    const { host, landed } = authorityLand();
    let hookCalls = 0;

    const result = await mergeForRun({
      queueDrive: true,
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed),
      baseShiftRebase: async () => ({ outcome: "conflict", message: "branch conflicts with base" }),
      resolveConflict: async (ctx) => {
        hookCalls += 1;
        expect(ctx.baseBranch).toBe("main");
        return { resolved: false };
      },
    });

    expect(result.outcome).toBe("conflict");
    expect(hookCalls).toBe(1);
    expect(landed).toEqual([]);
    const conflict = events.events.find((e) => e.eventType === "merge.conflict");
    expect(conflict?.payload).toMatchObject({ baseBranch: "main", message: "branch conflicts with base" });
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });
});

describe("external-change detection", () => {
  const identity = tanrenIdentity(["tanren[bot]", "tanren-bot-user"]);

  it("flags a non-Tanren login as an external change", () => {
    const out = assessExternalChange({ logins: ["tanren-bot-user", "alice"] }, identity);
    expect(out.hasExternalChange).toBe(true);
    expect(out.externalLogins).toEqual(["alice"]);
  });

  it("treats a Tanren-only PR (resolved login) as having no external change (case-insensitive)", () => {
    const out = assessExternalChange({ logins: ["Tanren-Bot-User", "tanren[bot]", "tanren-bot-user"] }, identity);
    expect(out.hasExternalChange).toBe(false);
    expect(out.externalLogins).toEqual([]);
  });

  it("treats an unattributed (empty) login as external and de-duplicates", () => {
    const out = assessExternalChange({ logins: ["", "", "bob", "bob"] }, identity);
    expect(out.hasExternalChange).toBe(true);
    expect(out.externalLogins).toEqual(["<unknown>", "bob"]);
  });

  it("with no Tanren identity, every contributor is external", () => {
    const out = assessExternalChange({ logins: ["tanren[bot]"] }, tanrenIdentity([]));
    expect(out.hasExternalChange).toBe(true);
  });

  it("excludes GitHub's web-flow merge-commit author but still flags real external logins", () => {
    expect(assessExternalChange({ logins: ["tanren-bot-user", "web-flow"] }, identity).hasExternalChange).toBe(false);
    const out = assessExternalChange({ logins: ["tanren-bot-user", "web-flow", "mallory"] }, identity);
    expect(out.hasExternalChange).toBe(true);
    expect(out.externalLogins).toEqual(["mallory"]);
  });
});

describe("posture decision", () => {
  const external = assessExternalChange({ logins: ["alice"] }, tanrenIdentity(["tanren[bot]"]));
  const internal = assessExternalChange({ logins: ["tanren[bot]"] }, tanrenIdentity(["tanren[bot]"]));

  it("open always proceeds", () => {
    expect(decidePosture("open", external).kind).toBe("proceed");
    expect(decidePosture("open", internal).kind).toBe("proceed");
  });

  it("strict blocks an external change, proceeds on Tanren-only", () => {
    expect(decidePosture("strict", external).kind).toBe("block");
    expect(decidePosture("strict", internal).kind).toBe("proceed");
  });

  it("audit_only observes an external change, proceeds on Tanren-only", () => {
    expect(decidePosture("audit_only", external).kind).toBe("observe");
    expect(decidePosture("audit_only", internal).kind).toBe("proceed");
  });

  it("lenient mirrors strict for external coexistence (the gate-advisory relaxation is in-loop only)", () => {
    const decision = decidePosture("lenient", external);
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("lenient posture");
    expect(decidePosture("lenient", internal).kind).toBe("proceed");
  });
});

describe("governance posture gate at the merge decision", () => {
  const externalProbe: ContributorProbe = {
    listContributors: async () => ({ logins: [FIXTURE_TANREN_LOGIN, "mallory"] }),
  };
  const internalProbe: ContributorProbe = {
    listContributors: async () => ({ logins: [FIXTURE_TANREN_LOGIN] }),
  };
  const unattributedProbe: ContributorProbe = {
    listContributors: async () => ({ logins: [FIXTURE_TANREN_LOGIN, ""] }),
  };

  it("strict + external change → merge.blocked (operator_approval), no land, task left running", async () => {
    const pool = new ReviewMergePool("native_queue", "strict");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const { host, landed } = authorityLand();

    const result = await mergeForRun({
      queueDrive: true,
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      githubHttp: tanrenUserHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed),
      contributorProbe: externalProbe,
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    const blocked = events.events.find((e) => e.eventType === "merge.blocked");
    expect(blocked?.payload).toMatchObject({
      posture: "strict",
      mode: "operator_approval",
      externalLogins: ["mallory"],
    });
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("audit_only + external change → merge.blocked (audit_only), no land", async () => {
    const pool = new ReviewMergePool("native_queue", "audit_only");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const { host, landed } = authorityLand();

    const result = await mergeForRun({
      queueDrive: true,
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      githubHttp: tanrenUserHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed),
      contributorProbe: externalProbe,
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    expect(events.events.find((e) => e.eventType === "merge.blocked")?.payload).toMatchObject({
      posture: "audit_only",
      mode: "audit_only",
    });
  });

  it("strict + Tanren-only change clears posture but cannot synthesize a per-run land", async () => {
    const pool = new ReviewMergePool("native_queue", "strict");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const { host, landed } = authorityLand();

    const result = await mergeForRun({
      queueDrive: true,
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      githubHttp: tanrenUserHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed),
      contributorProbe: internalProbe,
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    expect(events.events.find((e) => e.eventType === "merge.blocked")?.payload).toMatchObject({
      integration: "native_queue",
    });
  });

  it("strict + unattributed external commit ('') → merge.blocked (<unknown>), loud, no land", async () => {
    const pool = new ReviewMergePool("native_queue", "strict");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const { host, landed } = authorityLand();

    const result = await mergeForRun({
      queueDrive: true,
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      githubHttp: tanrenUserHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed),
      contributorProbe: unattributedProbe,
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    expect(events.events.find((e) => e.eventType === "merge.blocked")?.payload).toMatchObject({
      posture: "strict",
      mode: "operator_approval",
      externalLogins: ["<unknown>"],
    });
  });

  it("open + external change clears posture but cannot synthesize a per-run land", async () => {
    const pool = new ReviewMergePool("native_queue", "open");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const { host, landed } = authorityLand();

    const result = await mergeForRun({
      queueDrive: true,
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed),
      contributorProbe: externalProbe,
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
  });
});
