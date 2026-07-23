import { describe, expect, it, vi } from "vitest";
import { applyAbandonment, planAbandonment, postReminders, type AbandonmentGateway } from "../src/abandonment.js";
import type { PrState } from "../src/stateSchemas.js";
import type { NormalizedFinding } from "../src/triage.js";
import { firstSha, secondSha, testConfig } from "./helpers.js";

function state(): PrState {
  return {
    pr: 1240,
    lastSeenHeadSha: firstSha,
    lastReviewedHeadSha: firstSha,
    lastReviewedBaseSha: secondSha,
    auditedIssueNumber: 1247,
    rubricVersion: "2026-07-22",
    reviewId: 55,
    findingIds: ["wrong"],
    disposition: "changes_requested",
    firstAuthorActivityAt: "2026-07-01T00:00:00.000Z",
    lastAuthorActivityAt: "2026-07-01T00:00:00.000Z",
    awaitingAuthorSince: "2026-07-01T00:00:00.000Z",
    retry: { attempts: 0, nextAttemptAt: null, lastError: null },
    followUpIssues: [],
    reminderDaysSent: [],
    abandonmentReason: null,
    auditStatus: "completed",
  };
}

function finding(concerns: NormalizedFinding["concerns"] = "acceptance", body = "small repair"): NormalizedFinding {
  return {
    id: concerns,
    title: concerns,
    body,
    category: concerns === "acceptance" ? "correctness" : "betterment",
    severity: concerns === "acceptance" ? "P0" : "P2",
    locatable: false,
    path: null,
    line: null,
    side: null,
    evidence: "evidence",
    forced: false,
    concerns,
    fixDirection: null,
  };
}

class MemoryAbandonment implements AbandonmentGateway {
  public readonly comments: string[] = [];
  public closes = 0;
  public refreshes = 0;
  public async hasPrComment(_pr: number, marker: string) {
    return this.comments.some((comment) => comment.includes(marker));
  }
  public async commentPr(_pr: number, body: string) {
    this.comments.push(body);
  }
  public async closePr() {
    this.closes += 1;
  }
  public async refreshOriginalIssue() {
    this.refreshes += 1;
  }
}

describe("staleness and abandonment", () => {
  it("emits deterministic, idempotent day-3 and day-6 reminders", async () => {
    const atDay3 = planAbandonment(testConfig(), state(), {
      now: "2026-07-04T00:00:00.000Z",
      headSha: firstSha,
      substantiveAuthorActivityAt: null,
      findings: [],
    });
    expect(atDay3.reminderDays).toEqual([3]);
    const atDay6 = planAbandonment(testConfig(), atDay3.state, {
      now: "2026-07-07T00:00:00.000Z",
      headSha: firstSha,
      substantiveAuthorActivityAt: null,
      findings: [],
    });
    expect(atDay6.reminderDays).toEqual([6]);
    const gateway = new MemoryAbandonment();
    await postReminders(gateway, 1240, firstSha, [3, 6]);
    await postReminders(gateway, 1240, firstSha, [3, 6]);
    expect(gateway.comments).toHaveLength(2);
  });

  it("abandons after seven days and immediately for sweeping/wrong-direction findings", () => {
    const stale = planAbandonment(testConfig(), state(), {
      now: "2026-07-08T00:00:00.000Z",
      headSha: firstSha,
      substantiveAuthorActivityAt: null,
      findings: [],
    });
    expect(stale.abandon).toBe("inactivity");
    const wrong = planAbandonment(testConfig(), state(), {
      now: "2026-07-02T00:00:00.000Z",
      headSha: firstSha,
      substantiveAuthorActivityAt: null,
      findings: [finding("acceptance", "This implementation is the wrong direction and needs a new design.")],
    });
    expect(wrong.abandon).toBe("findings");
  });

  it("resets reminders and staleness on a new head or substantive author reply", () => {
    const reminded = { ...state(), reminderDaysSent: [3, 6] };
    const head = planAbandonment(testConfig(), reminded, {
      now: "2026-07-07T00:00:00.000Z",
      headSha: secondSha,
      substantiveAuthorActivityAt: null,
      findings: [],
    });
    expect(head).toMatchObject({ reset: true, reminderDays: [], abandon: null });
    expect(head.state).toMatchObject({ lastSeenHeadSha: secondSha, awaitingAuthorSince: null, reminderDaysSent: [] });
    const reply = planAbandonment(testConfig(), reminded, {
      now: "2026-07-07T00:00:00.000Z",
      headSha: firstSha,
      substantiveAuthorActivityAt: "2026-07-06T12:00:00.000Z",
      findings: [],
    });
    expect(reply.state).toMatchObject({
      lastAuthorActivityAt: "2026-07-06T12:00:00.000Z",
      awaitingAuthorSince: "2026-07-06T12:00:00.000Z",
      reminderDaysSent: [],
    });
  });

  it("closes without merge, refreshes the original issue, and deduplicates only genuinely new work", async () => {
    const gateway = new MemoryAbandonment();
    const route = vi.fn<(findings: readonly NormalizedFinding[]) => Promise<readonly number[]>>(async () => [1300]);
    const input = {
      pr: 1240,
      headSha: firstSha,
      sourceIssue: 1248,
      reason: "inactivity" as const,
      findings: [finding("acceptance"), finding("new_work")],
    };
    await applyAbandonment(gateway, input, route);
    await applyAbandonment(gateway, input, route);
    expect(gateway.comments).toHaveLength(1);
    expect(gateway.closes).toBe(2);
    expect(gateway.refreshes).toBe(2);
    expect(route).toHaveBeenCalledWith([expect.objectContaining({ concerns: "new_work" })]);
    expect(route.mock.calls[0]?.[0]).toHaveLength(1);
  });
});
