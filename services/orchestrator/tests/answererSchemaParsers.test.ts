import { describe, expect, it } from "vitest";

import {
  AuditAnswer,
  CheckAnswer,
  DemoAnswer,
  ForgeAnswer,
  PlanAnswer,
} from "../src/engine/answerers/schemas/index.js";

// Parser tests for the five Phase 2 Answerer schemas. Each role has a
// positive case + at least one negative case so the contract surface stays
// honest as the Zod sources evolve. The Phase 1 fixture regression assertion
// lives next to the check/audit cases: a representative single-spec fixture
// answer (no behavior ids declared yet because Phase 1 does not surface
// behaviors) must still validate.

describe("PlanAnswer", () => {
  it("accepts a multi-subtask plan with rationale", () => {
    const value = {
      subtasks: [
        {
          index: 0,
          title: "Add fixture marker file",
          intent: "Make Tanren-fixture-easy visibly mutated",
          behaviorIds: ["beh_marker"],
          estimatedTokens: 800,
        },
        {
          index: 1,
          title: "Update README",
          intent: "Document the marker",
          behaviorIds: [],
          estimatedTokens: null,
        },
      ],
      rationale: "Splitting the spec keeps each diff small enough for a single writer pass.",
    };
    expect(PlanAnswer.parse(value)).toEqual(value);
  });

  it("rejects empty subtask lists and unknown keys", () => {
    expect(() => PlanAnswer.parse({ subtasks: [], rationale: "nope" })).toThrow(/Too small/);
    expect(() =>
      PlanAnswer.parse({
        subtasks: [{ index: 0, title: "t", intent: "i", behaviorIds: [], estimatedTokens: null, extra: 1 }],
        rationale: "ok",
      }),
    ).toThrow(/Unrecognized key/);
  });
});

describe("CheckAnswer", () => {
  it("accepts a passing Phase-1-shaped fixture answer with empty behavior arrays", () => {
    // Phase 1 fixture spec declares no behaviors, so the regression payload
    // carries empty behavior arrays. This asserts Phase 1 fixture checker
    // results validate against the regenerated schema unchanged.
    const value = {
      passed: true,
      reasoning: "Diff adds PHASE1_FIXTURE.md with the required marker line.",
      behaviorIdsPassed: [],
      behaviorIdsFailed: [],
    };
    expect(CheckAnswer.parse(value)).toEqual(value);
  });

  it("accepts a partial-failure case with both behavior lists populated", () => {
    const value = {
      passed: false,
      reasoning: "Diff covers beh_marker but the README behavior was not touched.",
      behaviorIdsPassed: ["beh_marker"],
      behaviorIdsFailed: ["beh_readme_summary"],
    };
    expect(CheckAnswer.parse(value)).toEqual(value);
  });

  it("rejects missing fields and stray keys", () => {
    expect(() => CheckAnswer.parse({ passed: true })).toThrow(/Invalid input/);
    expect(() =>
      CheckAnswer.parse({
        passed: true,
        reasoning: "ok",
        behaviorIdsPassed: [],
        behaviorIdsFailed: [],
        extra: "stop",
      }),
    ).toThrow(/Unrecognized key/);
  });
});

describe("AuditAnswer", () => {
  it("accepts a passing Phase-1-shaped fixture audit with recommendedAction pass", () => {
    const value = {
      passed: true,
      reasoning: "Checker accepted the diff and the marker file matches the spec.",
      outstandingBehaviorIds: [],
      recommendedAction: "pass",
    };
    expect(AuditAnswer.parse(value)).toEqual(value);
  });

  it("accepts a loop_to_planner recommendation with outstanding behavior ids", () => {
    const value = {
      passed: false,
      reasoning: "beh_readme_summary still uncovered after one writer pass; planner should split the spec.",
      outstandingBehaviorIds: ["beh_readme_summary"],
      recommendedAction: "loop_to_planner",
    };
    expect(AuditAnswer.parse(value)).toEqual(value);
  });

  it("rejects unknown recommendedAction values", () => {
    expect(() =>
      AuditAnswer.parse({
        passed: false,
        reasoning: "x",
        outstandingBehaviorIds: [],
        recommendedAction: "retry",
      }),
    ).toThrow(/Invalid (?:input|option)/);
  });
});

describe("DemoAnswer", () => {
  it("accepts a narration with defaulted optional arrays", () => {
    const parsed = DemoAnswer.parse({
      headline: "Phase 1 fixture marker shipped",
      body: "Tanren added PHASE1_FIXTURE.md with the deterministic marker line and updated CI.",
      highlightBehaviorIds: ["beh_marker"],
    });
    expect(parsed.showStopperRisks).toEqual([]);
    expect(parsed.links).toEqual([]);
  });

  it("rejects malformed links", () => {
    expect(() =>
      DemoAnswer.parse({
        headline: "h",
        body: "b",
        highlightBehaviorIds: [],
        links: [{ label: "broken", url: "not a url" }],
      }),
    ).toThrow(/Invalid/);
  });
});

describe("ForgeAnswer", () => {
  it("accepts a body-only turn with defaulted arrays", () => {
    const parsed = ForgeAnswer.parse({ body: "Run run_abc completed in 4 minutes." });
    expect(parsed.attentionItems).toEqual([]);
    expect(parsed.insights).toEqual([]);
    expect(parsed.prompts).toEqual([]);
  });

  it("accepts an attention queue with a tanren.trigger_run suggested action", () => {
    const parsed = ForgeAnswer.parse({
      body: "Two specs are waiting on operator review.",
      attentionItems: [
        {
          priority: "review",
          title: "Review spec_42",
          sub: "draft PR open for 18m",
          action: {
            label: "trigger rerun",
            toolCall: { tool: "tanren.trigger_run", args: { specId: "spec_42" } },
          },
        },
      ],
    });
    expect(parsed.attentionItems[0]?.action?.toolCall.tool).toBe("tanren.trigger_run");
  });

  it("accepts a retry_hotspot insight with a switch-style action", () => {
    const parsed = ForgeAnswer.parse({
      body: "Detected retry hotspot on spec_99.",
      insights: [
        {
          kind: "retry_hotspot",
          title: "Retry hotspot",
          body: "writer-codex retried spec_99 four times in the last hour.",
          actions: [
            {
              label: "rerun task_77 with the cheaper writer",
              toolCall: { tool: "tanren.rerun_task", args: { taskId: "task_77" } },
            },
          ],
        },
      ],
    });
    expect(parsed.insights[0]?.kind).toBe("retry_hotspot");
  });

  it("rejects unknown tool names in suggested actions", () => {
    expect(() =>
      ForgeAnswer.parse({
        body: "x",
        attentionItems: [
          {
            priority: "info",
            title: "t",
            sub: "s",
            action: {
              label: "do something",
              toolCall: { tool: "tanren.launch_missiles", args: {} },
            },
          },
        ],
      }),
    ).toThrow(/Invalid (?:input|option|discriminator)/);
  });
});
