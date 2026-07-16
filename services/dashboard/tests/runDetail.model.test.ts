// unit tests for the pure run-detail view-model derivations
// (cost summary, trajectory spine, reasoning extraction). No DOM, no rendering.

import { describe, expect, it } from "vitest";
import {
  buildTrajectory,
  derivePreviewUrl,
  failedTasks,
  formatDuration,
  prNumberFrom,
  reasoningForTask,
  reviewMergeStateFromEvents,
  runFailed,
  spineProgress,
  formatSourceAmt,
  summarizeCosts,
  taskState,
} from "../src/components/runDetail/model.js";
import type { RunCostRecord, RunDetail, RunEventRow, TaskTimelineEntry } from "../src/api/types.js";

function ev(eventType: string, payload: unknown = {}): RunEventRow {
  return {
    id: 1,
    ts: "2026-05-28T10:00:00.000Z",
    runId: "run_1",
    taskId: null,
    specId: null,
    projectId: null,
    eventType,
    payload,
    redactedPaths: [],
  };
}

function task(over: Partial<TaskTimelineEntry>): TaskTimelineEntry {
  return {
    taskId: "t1",
    runId: "run_1",
    kind: "write",
    parentTaskId: null,
    title: "do a thing",
    status: "done",
    outcome: "passed",
    failureKind: null,
    attempt: 0,
    cli: "codex",
    model: "gpt-x",
    startedAt: "2026-05-28T10:00:00.000Z",
    endedAt: "2026-05-28T10:01:00.000Z",
    ...over,
  };
}

function cost(over: Partial<RunCostRecord>): RunCostRecord {
  return {
    id: 1,
    runId: "run_1",
    taskId: "t1",
    projectId: "p1",
    cli: "codex",
    provider: "openai",
    model: "gpt-x",
    inputTokens: 100,
    cachedInputTokens: 10,
    cacheCreationTokens: 0,
    outputTokens: 50,
    reasoningOutputTokens: 0,
    totalTokens: 150,
    costUsd: "0.0200",
    billingMode: "per_token",
    costBasis: "provider_response",
    recordedAt: "2026-05-28T10:00:30.000Z",
    ...over,
  };
}

describe("reviewMergeStateFromEvents — P3-0008 review/merge phase", () => {
  it("defaults to none with no review/merge events", () => {
    expect(reviewMergeStateFromEvents([]).phase).toBe("none");
  });

  it("tracks the review→merge progression to merged with the latest event winning", () => {
    const state = reviewMergeStateFromEvents([
      ev("github.pr.ready", { prUrl: "u", prNumber: 7 }),
      ev("review.requested", { prUrl: "u", prNumber: 7 }),
      ev("review.approved", { prUrl: "u", prNumber: 7 }),
      ev("merge.queued", { prUrl: "u", prNumber: 7, integration: "direct_merge" }),
      ev("merge.completed", {
        prUrl: "u",
        prNumber: 7,
        integration: "direct_merge",
        mergeSha: "abc123",
      }),
    ]);
    expect(state.phase).toBe("merged");
    expect(state.mergeSha).toBe("abc123");
    expect(state.integration).toBe("direct_merge");
  });

  it("surfaces changes_requested with the reviewer message", () => {
    const state = reviewMergeStateFromEvents([
      ev("review.requested", { prUrl: "u", prNumber: 7 }),
      ev("review.changes_requested", { prUrl: "u", prNumber: 7, message: "fix it" }),
    ]);
    expect(state.phase).toBe("changes_requested");
    expect(state.message).toBe("fix it");
  });

  it("gv-2: binds complete forge publication from review.approved", () => {
    const headSha = "a".repeat(40);
    const state = reviewMergeStateFromEvents([
      ev("review.approved", {
        prUrl: "u",
        prNumber: 7,
        reviewer: "reviewer-bot",
        forgeReviewId: "9001",
        forgeReviewState: "approved",
        forgeReviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-9001",
        headSha,
      }),
    ]);
    expect(state.phase).toBe("approved");
    expect(state.forgePublication?.complete).toBe(true);
    expect(state.forgePublication?.forgeReviewId).toBe("9001");
    expect(state.forgePublication?.headSha).toBe(headSha);
  });

  it("gv-2 former-bug: terminal review with ZERO forge fields is unpublished (undefined), not danger-partial", () => {
    // A human/auto terminal review.approved carrying no forge receipt must NOT
    // render as the loud "partial forge fields present" danger — there is no
    // receipt at all, so the neutral unpublished state (undefined) holds.
    const state = reviewMergeStateFromEvents([ev("review.approved", { prUrl: "u", prNumber: 7 })]);
    expect(state.phase).toBe("approved");
    expect(state.forgePublication).toBeUndefined();
  });

  it("gv-2 former-bug: a lone reviewer (no receipt fields) is still unpublished", () => {
    // Only a non-receipt field present — there is still no id/state/url/headSha
    // receipt, so this is unpublished, never the danger partial-receipt state.
    const state = reviewMergeStateFromEvents([
      ev("review.changes_requested", { prUrl: "u", prNumber: 7, reviewer: "human", message: "nits" }),
    ]);
    expect(state.phase).toBe("changes_requested");
    expect(state.forgePublication).toBeUndefined();
  });

  it("gv-2: partial forge fields are never complete (loud UI path)", () => {
    const state = reviewMergeStateFromEvents([
      ev("review.approved", {
        prUrl: "u",
        prNumber: 7,
        forgeReviewId: "9001",
        // missing state/url/head — a strict subset is a malformed receipt
      }),
    ]);
    expect(state.forgePublication?.complete).toBe(false);
    expect(state.forgePublication?.forgeReviewId).toBe("9001");
  });

  it("surfaces a merge conflict as a recoverable phase", () => {
    const state = reviewMergeStateFromEvents([
      ev("merge.queued", { prUrl: "u", prNumber: 7, integration: "direct_merge" }),
      ev("merge.conflict", {
        prUrl: "u",
        prNumber: 7,
        integration: "direct_merge",
        baseBranch: "main",
        message: "conflict",
      }),
    ]);
    expect(state.phase).toBe("merge_conflict");
    expect(state.message).toBe("conflict");
  });
});

describe("summarizeCosts — cost bar across all sources", () => {
  it("aggregates real dollars, tokens, and per-source/per-model totals", () => {
    const totals = summarizeCosts([
      cost({
        id: 1,
        billingMode: "per_token",
        costUsd: "0.0200",
        totalTokens: 150,
        model: "gpt-x",
      }),
      cost({
        id: 2,
        billingMode: "subscription",
        costUsd: null,
        totalTokens: 300,
        model: "claude-y",
        provider: "anthropic",
      }),
      cost({
        id: 3,
        billingMode: "self_hosted",
        costUsd: "0.0000",
        totalTokens: 80,
        model: "local-z",
      }),
    ]);
    expect(totals.perTokenUsd).toBeCloseTo(0.02, 5);
    expect(totals.totalTokens).toBe(530);
    expect(totals.bySource.get("per_token")?.tokens).toBe(150);
    expect(totals.bySource.get("subscription")?.tokens).toBe(300);
    expect(totals.bySource.get("subscription")?.unknownRecords).toBe(1);
    expect(totals.bySource.get("self_hosted")?.tokens).toBe(80);
    expect(totals.byModel.get("claude-y")?.provider).toBe("anthropic");
    // never invents an unknown source: only the three real billing modes appear
    expect([...totals.bySource.keys()].sort()).toEqual(["per_token", "self_hosted", "subscription"]);
  });

  it("never launders null costUsd into $0 — tokens still aggregate", () => {
    const totals = summarizeCosts([cost({ costUsd: null, totalTokens: 42 })]);
    expect(totals.perTokenUsd).toBeNull();
    expect(totals.perTokenHasUnknown).toBe(true);
    expect(totals.perTokenKnownUsd).toBe(0);
    expect(totals.totalTokens).toBe(42);
  });

  it("keeps a known subtotal when some USD is unknown (partial coverage)", () => {
    const totals = summarizeCosts([
      cost({ id: 1, costUsd: "0.05", totalTokens: 10 }),
      cost({ id: 2, costUsd: null, totalTokens: 20 }),
    ]);
    expect(totals.perTokenUsd).toBeCloseTo(0.05, 5);
    expect(totals.perTokenHasUnknown).toBe(true);
    expect(totals.perTokenKnownUsd).toBeCloseTo(0.05, 5);
    expect(totals.totalTokens).toBe(30);
  });

  it("preserves a genuine known zero", () => {
    const totals = summarizeCosts([cost({ costUsd: "0", totalTokens: 5 })]);
    expect(totals.perTokenUsd).toBe(0);
    expect(totals.perTokenHasUnknown).toBe(false);
  });

  it("four per-source coverage cases: known-zero, all-null, partial-nonzero, partial-known-zero", () => {
    // known-zero (priced $0 only)
    expect(formatSourceAmt({ tokens: 5, knownUsd: 0, unknownRecords: 0, pricedRecords: 1 })).toContain("$0.0000");
    expect(formatSourceAmt({ tokens: 5, knownUsd: 0, unknownRecords: 0, pricedRecords: 1 })).not.toContain("unknown");
    // all-null
    expect(formatSourceAmt({ tokens: 10, knownUsd: 0, unknownRecords: 2, pricedRecords: 0 })).toContain("unknown");
    expect(formatSourceAmt({ tokens: 10, knownUsd: 0, unknownRecords: 2, pricedRecords: 0 })).not.toContain("$0");
    // partial-nonzero (priced + null)
    const partial = formatSourceAmt({ tokens: 30, knownUsd: 0.05, unknownRecords: 1, pricedRecords: 1 });
    expect(partial).toContain("$0.0500 known");
    // partial-known-zero (priced $0 + null) — must NOT read wholly unknown
    const partialZero = formatSourceAmt({ tokens: 20, knownUsd: 0, unknownRecords: 1, pricedRecords: 1 });
    expect(partialZero).toContain("$0.0000 known");
    expect(partialZero).not.toMatch(/tok · unknown$/u);

    // SSR summarizeCosts tracks pricedRecords per source for the same cases
    const knownZero = summarizeCosts([cost({ costUsd: "0", billingMode: "subscription" })]);
    expect(knownZero.bySource.get("subscription")?.pricedRecords).toBe(1);
    expect(knownZero.bySource.get("subscription")?.knownUsd).toBe(0);

    const allNull = summarizeCosts([
      cost({ id: 1, costUsd: null, billingMode: "subscription" }),
      cost({ id: 2, costUsd: null, billingMode: "subscription" }),
    ]);
    expect(allNull.bySource.get("subscription")?.pricedRecords).toBe(0);
    expect(allNull.bySource.get("subscription")?.unknownRecords).toBe(2);

    const partialNonzero = summarizeCosts([
      cost({ id: 1, costUsd: "0.05", billingMode: "per_token" }),
      cost({ id: 2, costUsd: null, billingMode: "per_token" }),
    ]);
    expect(partialNonzero.bySource.get("per_token")?.pricedRecords).toBe(1);
    expect(partialNonzero.bySource.get("per_token")?.unknownRecords).toBe(1);
    expect(partialNonzero.bySource.get("per_token")?.knownUsd).toBeCloseTo(0.05, 5);

    const partialKnownZero = summarizeCosts([
      cost({ id: 1, costUsd: "0", billingMode: "per_token" }),
      cost({ id: 2, costUsd: null, billingMode: "per_token" }),
    ]);
    expect(partialKnownZero.bySource.get("per_token")?.pricedRecords).toBe(1);
    expect(partialKnownZero.bySource.get("per_token")?.unknownRecords).toBe(1);
    expect(partialKnownZero.bySource.get("per_token")?.knownUsd).toBe(0);
    expect(formatSourceAmt(partialKnownZero.bySource.get("per_token")!)).toContain("$0.0000 known");
  });
});

describe("runStream browser coverage (count-based, upsert)", () => {
  it("four per-source cases + same-id null→known upsert once", async () => {
    const { formatSourceAmtForTest, recomputeTotalsFromFrames } = await import("../src/client/runStream.js");
    expect(formatSourceAmtForTest({ tokens: 1, knownUsd: 0, unknownRecords: 0, pricedRecords: 1 })).toContain(
      "$0.0000",
    );
    expect(formatSourceAmtForTest({ tokens: 1, knownUsd: 0, unknownRecords: 1, pricedRecords: 0 })).toContain(
      "unknown",
    );
    expect(formatSourceAmtForTest({ tokens: 1, knownUsd: 0.04, unknownRecords: 1, pricedRecords: 1 })).toContain(
      "known",
    );
    expect(formatSourceAmtForTest({ tokens: 1, knownUsd: 0, unknownRecords: 1, pricedRecords: 1 })).toContain(
      "$0.0000 known",
    );

    // Upsert same id: null then $1.00 — counts once priced, not double-summed.
    const after = recomputeTotalsFromFrames([
      {
        id: "9007199254740993",
        billingMode: "per_token",
        model: "m",
        inputTokens: 1,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 1,
        costUsd: null,
      },
      {
        id: "9007199254740993",
        billingMode: "per_token",
        model: "m",
        inputTokens: 1,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 1,
        costUsd: "1.00",
      },
    ]);
    expect(after.perTokenPriced).toBe(1);
    expect(after.perTokenUnknown).toBe(0);
    expect(after.perTokenKnownUsd).toBeCloseTo(1, 5);
    expect(after.totalTokens).toBe(1);
  });
});

describe("trajectory spine", () => {
  it("orders moments by start, numbers write subtasks, and maps states", () => {
    const moments = buildTrajectory([
      task({ taskId: "plan", kind: "plan", title: "plan", startedAt: "2026-05-28T10:00:00.000Z" }),
      task({ taskId: "w1", kind: "write", startedAt: "2026-05-28T10:01:00.000Z", status: "done" }),
      task({
        taskId: "w2",
        kind: "write",
        startedAt: "2026-05-28T10:02:00.000Z",
        status: "running",
        outcome: null,
        endedAt: null,
      }),
      task({
        taskId: "audit",
        kind: "audit",
        status: "queued",
        outcome: null,
        startedAt: null,
        endedAt: null,
      }),
    ]);
    expect(moments.map((m) => m.taskId)).toEqual(["plan", "w1", "w2", "audit"]);
    expect(moments[1].phase).toBe("write subtask 1");
    expect(moments[2].phase).toBe("write subtask 2");
    expect(moments[2].state).toBe("live");
    expect(moments[3].state).toBe("queued");
  });

  it("maps rejected outcomes to a failed state (the rejection loop)", () => {
    expect(taskState(task({ status: "done", outcome: "rejected_by_auditor" }))).toBe("failed");
    expect(taskState(task({ status: "done", outcome: "rejected_by_checker" }))).toBe("failed");
  });

  it("derives a gradient where done < live", () => {
    const moments = buildTrajectory([
      task({ taskId: "a", status: "done", startedAt: "2026-05-28T10:00:00.000Z" }),
      task({
        taskId: "b",
        status: "running",
        outcome: null,
        endedAt: null,
        startedAt: "2026-05-28T10:01:00.000Z",
      }),
      task({ taskId: "c", status: "queued", outcome: null, startedAt: null, endedAt: null }),
    ]);
    const { donePct, livePct } = spineProgress(moments);
    expect(donePct).toBeLessThan(livePct);
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes, empty when unstarted", () => {
    expect(formatDuration("2026-05-28T10:00:00.000Z", "2026-05-28T10:00:45.000Z")).toBe("45s");
    expect(formatDuration("2026-05-28T10:00:00.000Z", "2026-05-28T10:02:05.000Z")).toBe("2m 5s");
    expect(formatDuration(null, null)).toBe("");
  });
});

describe("reasoningForTask — structured fields from typed events (not stdout)", () => {
  it("extracts intent, tool calls, and decisions from the event payloads", () => {
    const detail = {
      tasks: [task({ taskId: "w2" })],
      recentEvents: [
        {
          id: 1,
          ts: "",
          runId: "run_1",
          taskId: "w2",
          specId: null,
          projectId: null,
          eventType: "writer.intent",
          payload: { intent: "wire localStorage persistence" },
          redactedPaths: [],
        },
        {
          id: 2,
          ts: "",
          runId: "run_1",
          taskId: "w2",
          specId: null,
          projectId: null,
          eventType: "tool.call",
          payload: { tool: "edit_file", arg: "settings.tsx", output: "+12 -3" },
          redactedPaths: [],
        },
        {
          id: 3,
          ts: "",
          runId: "run_1",
          taskId: "w2",
          specId: null,
          projectId: null,
          eventType: "writer.decision",
          payload: { decisions: ["use useEffect", "defer profile sync"] },
          redactedPaths: [],
        },
        {
          id: 4,
          ts: "",
          runId: "run_1",
          taskId: "other",
          specId: null,
          projectId: null,
          eventType: "noise",
          payload: { intent: "ignore me" },
          redactedPaths: [],
        },
      ],
    } as unknown as RunDetail;
    const reasoning = reasoningForTask(detail, "w2");
    expect(reasoning.intent).toBe("wire localStorage persistence");
    expect(reasoning.tools).toHaveLength(1);
    expect(reasoning.tools[0].name).toBe("edit_file");
    expect(reasoning.decisions).toEqual(["use useEffect", "defer profile sync"]);
    // only this moment's events are surfaced
    expect(reasoning.events.every((e) => e.taskId === "w2")).toBe(true);
  });
});

describe("failure detection (rejection loop inspection)", () => {
  it("flags failed/halted runs and lists the rejected tasks", () => {
    const detail = {
      run: { status: "halted", outcome: "halted" },
      tasks: [
        task({ taskId: "ok", status: "done", outcome: "passed" }),
        task({
          taskId: "bad",
          status: "done",
          outcome: "rejected_by_auditor",
          failureKind: "auditor_disagreement",
        }),
      ],
    } as unknown as RunDetail;
    expect(runFailed(detail)).toBe(true);
    expect(failedTasks(detail).map((t) => t.taskId)).toEqual(["bad"]);
  });
});

function previewRun(over: { branch?: string; prUrl?: string | null } = {}): {
  branch: string;
  prUrl: string | null;
} {
  return {
    branch: over.branch ?? "tanren/spec_settings",
    prUrl: over.prUrl === undefined ? "https://github.com/cat-cave/repo/pull/142" : over.prUrl,
  };
}

describe("derivePreviewUrl — P3-0025 per-PR preview-deploy URL", () => {
  const run = previewRun;

  it("returns null when no pattern is configured (graceful empty state)", () => {
    expect(derivePreviewUrl(undefined, run())).toBeNull();
    expect(derivePreviewUrl("", run())).toBeNull();
  });

  it("fills the {pr} placeholder from the PR url", () => {
    expect(derivePreviewUrl("https://pr-{pr}.preview.fly.dev", run())).toBe("https://pr-142.preview.fly.dev");
  });

  it("fills the {branch} placeholder (url-encoded)", () => {
    expect(derivePreviewUrl("https://preview.example.com/{branch}", run())).toBe(
      "https://preview.example.com/tanren%2Fspec_settings",
    );
  });

  it("returns null when the pattern needs {pr} but the run has no PR yet", () => {
    expect(derivePreviewUrl("https://pr-{pr}.preview.fly.dev", run({ prUrl: null }))).toBeNull();
  });

  it("still derives a branch-only URL when there is no PR", () => {
    expect(derivePreviewUrl("https://preview.example.com/{branch}", run({ prUrl: null }))).toBe(
      "https://preview.example.com/tanren%2Fspec_settings",
    );
  });

  it("refuses non-http(s) origins (no javascript: into an iframe src)", () => {
    expect(derivePreviewUrl("javascript:alert(1)", run())).toBeNull();
    expect(derivePreviewUrl("data:text/html,x", run())).toBeNull();
  });

  it("prNumberFrom parses GitHub PR urls and returns null otherwise", () => {
    expect(prNumberFrom("https://github.com/o/r/pull/77")).toBe("77");
    expect(prNumberFrom("https://github.com/o/r")).toBeNull();
    expect(prNumberFrom(null)).toBeNull();
  });
});
