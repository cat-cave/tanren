// P2A-0019: templated v0 narration generator tests.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { ForgeAnswer } from "../src/engine/answerers/schemas/forge.js";
import {
  generateProjectViewNarration,
  generateRunDetailNarration,
  type NarrationInput,
  type RunDetailNarrationInput,
} from "../src/engine/forge/index.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: "project_a",
  scopes: ["org:member", "project:member"],
  source: "session",
};

const baseInput: NarrationInput = {
  project: { projectId: "project_a", name: "Supplier Tools" },
  recentRuns: [
    {
      runId: "run_1",
      specId: "spec_1",
      status: "completed",
      outcome: "merged",
      prUrl: "https://github.com/example/repo/pull/141",
      startedAt: new Date("2026-05-20T10:00:00Z"),
      endedAt: new Date("2026-05-20T11:00:00Z"),
    },
    {
      runId: "run_2",
      specId: "spec_2",
      status: "completed",
      outcome: "passed",
      prUrl: "https://github.com/example/repo/pull/142",
      startedAt: new Date("2026-05-21T09:00:00Z"),
      endedAt: new Date("2026-05-21T10:30:00Z"),
      title: "supplier scorecard",
    },
    {
      runId: "run_3",
      specId: "spec_3",
      status: "running",
      outcome: null,
      prUrl: null,
      startedAt: new Date("2026-05-26T12:00:00Z"),
      endedAt: null,
    },
  ],
  pendingReviews: [
    {
      runId: "run_2",
      specId: "spec_2",
      status: "completed",
      outcome: "passed",
      prUrl: "https://github.com/example/repo/pull/142",
      startedAt: new Date("2026-05-21T09:00:00Z"),
      endedAt: new Date("2026-05-21T10:30:00Z"),
      title: "supplier scorecard",
    },
  ],
  weekToDateCostUsd: 42.5,
  velocity: { specsLast14Days: 6, aheadDays: 1 },
  insights: [
    {
      id: "insight_1",
      kind: "retry_hotspot",
      title: "Same spec retried 3 times",
      body: "spec_2 ran 3 times across writers — consider escalating.",
      actions: [
        {
          label: "Acknowledge",
          toolCall: { tool: "tanren.acknowledge_insight", args: { insightId: "insight_1" } },
        },
      ],
    },
  ],
  actor,
};

describe("generateProjectViewNarration", () => {
  it("produces a valid ForgeAnswer parseable by the P2A-0008 schema", () => {
    const answer = generateProjectViewNarration(baseInput);
    expect(() => ForgeAnswer.parse(answer)).not.toThrow();
  });

  it("renders the project pulse with active and review-ready counts", () => {
    const answer = generateProjectViewNarration(baseInput);
    expect(answer.body).toContain("Supplier Tools");
    expect(answer.body).toMatch(/1 run in flight/);
    expect(answer.body).toMatch(/1 PR review-ready/);
    expect(answer.body).toMatch(/\$42/);
  });

  it("emits a review-priority attention item that points at PR #142", () => {
    const answer = generateProjectViewNarration(baseInput);
    const reviewItem = answer.attentionItems.find((entry) => entry.priority === "review");
    expect(reviewItem).toBeDefined();
    expect(reviewItem?.title).toMatch(/PR #142/);
    const toolCall = reviewItem?.action?.toolCall;
    expect(toolCall?.tool).toBe("tanren.read_run");
    // Cast is safe — we asserted the tool literal above; the discriminator
    // narrows `args` to `{ runId: string }` for the dashboard's open-run CTA.
    const args = (toolCall as { args: { runId: string } } | undefined)?.args;
    expect(args?.runId).toBe("run_2");
  });

  it("emits a budget item when WTD spend exceeds the budget", () => {
    const answer = generateProjectViewNarration({ ...baseInput, budgetUsdPerWeek: 20 });
    const budgetItem = answer.attentionItems.find((entry) => entry.priority === "budget");
    expect(budgetItem).toBeDefined();
    expect(budgetItem?.action?.toolCall.tool).toBe("tanren.read_costs");
  });

  it("passes insights through unchanged", () => {
    const answer = generateProjectViewNarration(baseInput);
    expect(answer.insights).toHaveLength(1);
    expect(answer.insights[0]?.kind).toBe("retry_hotspot");
  });

  it("falls back to an idle pulse when no runs and no reviews", () => {
    const answer = generateProjectViewNarration({
      ...baseInput,
      recentRuns: [],
      pendingReviews: [],
    });
    expect(answer.body).toMatch(/idle/);
    expect(answer.attentionItems.filter((entry) => entry.priority === "review")).toHaveLength(0);
  });

  it("emits blocked items for failed runs", () => {
    const answer = generateProjectViewNarration({
      ...baseInput,
      recentRuns: [
        {
          runId: "run_x",
          specId: "spec_x",
          status: "failed",
          outcome: "failed",
          prUrl: null,
          startedAt: new Date(),
          endedAt: new Date(),
        },
      ],
      pendingReviews: [],
    });
    const blocked = answer.attentionItems.find((entry) => entry.priority === "blocked");
    expect(blocked).toBeDefined();
  });
});

describe("generateRunDetailNarration", () => {
  const runInput: RunDetailNarrationInput = {
    project: { projectId: "project_a", name: "Supplier Tools" },
    run: {
      runId: "run_2",
      specId: "spec_2",
      status: "completed",
      outcome: "passed",
      prUrl: "https://github.com/example/repo/pull/142",
      startedAt: new Date("2026-05-21T09:00:00Z"),
      endedAt: new Date("2026-05-21T10:30:00Z"),
      title: "supplier scorecard",
    },
    taskCount: 5,
    failedTaskCount: 0,
    costUsd: 4.25,
    insights: [],
    actor,
  };

  it("emits a review-ready attention item when a non-merged PR is present", () => {
    const answer = generateRunDetailNarration(runInput);
    expect(() => ForgeAnswer.parse(answer)).not.toThrow();
    expect(answer.attentionItems.some((entry) => entry.priority === "review")).toBe(true);
  });

  it("emits a blocked item when a task has failed", () => {
    const answer = generateRunDetailNarration({ ...runInput, failedTaskCount: 2 });
    expect(answer.attentionItems.some((entry) => entry.priority === "blocked")).toBe(true);
  });
});
