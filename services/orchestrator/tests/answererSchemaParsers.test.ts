import { describe, expect, it } from "vitest";

import {
  AuditAnswer,
  AuditFinding,
  CheckAnswer,
  DemoAnswer,
  ForgeAnswer,
  normalizeFinding,
  PlanAnswer,
} from "../src/engine/answerers/schemas/index.js";

// Parser tests for the five Answerer schemas. Each role has a
// positive case + at least one negative case so the contract surface stays
// honest as the Zod sources evolve. The fixture regression assertion
// lives next to the check/audit cases: a representative single-spec fixture
// answer (no behavior ids declared yet because the fixture does not surface
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
    expect(() => PlanAnswer.parse({ subtasks: [], rationale: "nope" })).toThrow(/Too small/u);
    expect(() =>
      PlanAnswer.parse({
        subtasks: [{ index: 0, title: "t", intent: "i", behaviorIds: [], estimatedTokens: null, extra: 1 }],
        rationale: "ok",
      }),
    ).toThrow(/Unrecognized key/u);
  });
});

describe("CheckAnswer", () => {
  it("SPEC-LOOP REDESIGN: a complete task emits an EXPLICIT empty findings list", () => {
    const value = {
      findings: [],
      reasoning: "Diff adds PHASE1_FIXTURE.md with the required marker line for downstream tasks.",
    };
    expect(CheckAnswer.parse(value)).toEqual(value);
  });

  it("accepts an incomplete task with completeness findings (each tying to a behavior)", () => {
    const value = {
      findings: [
        {
          id: "readme-missing",
          title: "README behavior not touched",
          body: "downstream docs task needs it",
          behaviorId: "beh_readme_summary",
        },
      ],
      reasoning: "Diff covers beh_marker but the README behavior was not touched.",
    };
    expect(CheckAnswer.parse(value).findings).toHaveLength(1);
  });

  it("rejects a missing findings list (no `.default([])`) and stray keys", () => {
    expect(() => CheckAnswer.parse({ reasoning: "ok" })).toThrow(/Invalid input/u);
    expect(() => CheckAnswer.parse({ findings: [], reasoning: "ok", extra: "stop" })).toThrow(/Unrecognized key/u);
  });
});

describe("AuditAnswer", () => {
  it("SPEC-LOOP REDESIGN: an audited-CLEAN answer MUST emit an EXPLICIT `findings: []` (the only way to clean)", () => {
    const value = { findings: [] };
    expect(AuditAnswer.parse(value)).toEqual(value);
    expect(AuditAnswer.parse(value).findings).toEqual([]);
  });

  it("an answer that OMITS `findings` is INVALID — it FAILS TO PARSE (no clean-[] default)", () => {
    expect(() => AuditAnswer.parse({})).toThrow(/findings/iu);
    // A legacy-shaped (passed/recommendedAction) answer with no findings also fails.
    const omitted = { passed: true, reasoning: "looks fine", recommendedAction: "pass" };
    expect(() => AuditAnswer.parse(omitted)).toThrow(/Invalid|Unrecognized|findings/iu);
  });

  it("rejects the DELETED narration fields (passed/recommendedAction) as unknown keys", () => {
    expect(() => AuditAnswer.parse({ findings: [], passed: true })).toThrow(/Unrecognized key/u);
    expect(() => AuditAnswer.parse({ findings: [], recommendedAction: "pass" })).toThrow(/Unrecognized key/u);
  });

  it("accepts a findings list (findings are the SOLE currency)", () => {
    const value = {
      findings: [{ id: "uncovered-beh", severity: "P1" as const, title: "behavior uncovered", body: "b" }],
    };
    expect(AuditAnswer.parse(value).findings.map((f) => f.severity)).toEqual(["P1"]);
  });

  it("accepts explicit P0–P3 findings (with optional fixHint)", () => {
    const value = {
      findings: [
        { id: "null-deref-import", severity: "P0", title: "Null deref on import", body: "x.y is read when x is null." },
        {
          id: "missing-test",
          severity: "P2",
          title: "No test for empty file",
          body: "Add a coverage case.",
          fixHint: "add empty-file test",
        },
      ],
    };
    const parsed = AuditAnswer.parse(value);
    expect(parsed.findings.map((f) => f.severity)).toEqual(["P0", "P2"]);
    expect(parsed.findings[1]?.fixHint).toBe("add empty-file test");
  });

  it("accepts a finding with fixHint:null (the strict-schema omitted form) AND with fixHint omitted, normalizing both to the same stored shape", () => {
    // Regression (P-A review): the GENERATED strict schema the CLI is sent makes
    // every key required + expresses an omitted `fixHint` as `null`. The Zod source
    // (the runtime parser) MUST accept that `null`, else a valid no-hint finding is
    // rejected before the verdict can be recorded. Both forms normalize to the frozen
    // `{ fixHint?: string }` Finding contract — byte-identical, with NO `fixHint` key.
    const withNull = AuditFinding.parse({ id: "f", severity: "P1", title: "t", body: "b", fixHint: null });
    const withOmitted = AuditFinding.parse({ id: "f", severity: "P1", title: "t", body: "b" });

    // The raw parse accepts the null (it does not throw) and keeps it null/undefined.
    expect(withNull.fixHint).toBeNull();
    expect(withOmitted.fixHint).toBeUndefined();

    // Normalization collapses BOTH to an absent key — identical stored shape.
    const normalizedNull = normalizeFinding(withNull);
    const normalizedOmitted = normalizeFinding(withOmitted);
    expect(normalizedNull).toEqual(normalizedOmitted);
    expect(normalizedNull).not.toHaveProperty("fixHint");
    expect(normalizedNull).toEqual({ id: "f", severity: "P1", title: "t", body: "b" });
  });

  it("the full AuditAnswer parse succeeds with a fixHint:null finding", () => {
    const parsed = AuditAnswer.parse({
      findings: [{ id: "p1", severity: "P1", title: "t", body: "b", fixHint: null }],
    });
    expect(parsed.findings[0]?.fixHint).toBeNull();
    expect(normalizeFinding(parsed.findings[0]!)).not.toHaveProperty("fixHint");
  });

  it("rejects an unknown finding severity", () => {
    expect(() => AuditAnswer.parse({ findings: [{ id: "x", severity: "P9", title: "t", body: "b" }] })).toThrow(
      /Invalid (?:input|option)/u,
    );
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
    ).toThrow(/Invalid/u);
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
    ).toThrow(/Invalid (?:input|option|discriminator)/u);
  });
});
