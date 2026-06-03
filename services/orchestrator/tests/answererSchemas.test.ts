import { describe, expect, it } from "vitest";
import {
  auditAnswerSchema,
  buildAuditPrompt,
  buildCheckPrompt,
  checkAnswerSchema,
  planAnswerSchema,
  type CheckAnswer,
} from "../src/engine/providers/answererSchemas.js";

describe("structured Answerer schemas", () => {
  it("validates check answers strictly", () => {
    const valid = {
      done: true,
      reason: "The diff satisfies the spec.",
      suggested_fixes: null,
    };

    expect(checkAnswerSchema.parse(valid)).toEqual(valid);
    expect(() => checkAnswerSchema.parse({ ...valid, extra: "nope" })).toThrow(/Unrecognized key/u);
    expect(() => checkAnswerSchema.parse({ ...valid, done: "maybe" })).toThrow(/Invalid input/u);
  });

  it("validates audit answers strictly", () => {
    const valid = {
      verified: true,
      criteria_status: {
        criteria: [{ criterion: "Adds marker file", satisfied: true, reason: "The diff adds MARKER.md." }],
      },
      reason: "The check is complete.",
    };

    expect(auditAnswerSchema.parse(valid)).toEqual(valid);
    expect(() => auditAnswerSchema.parse({ ...valid, unknown: true })).toThrow(/Unrecognized key/u);
    expect(() =>
      auditAnswerSchema.parse({
        ...valid,
        criteria_status: { criteria: [{ criterion: "", satisfied: true, reason: "ok" }] },
      }),
    ).toThrow(/Too small/u);
  });

  it("validates plan answers with acceptance criteria", () => {
    const valid = {
      subtasks: [{ title: "Add marker", acceptanceCriteria: ["README includes ok"] }],
    };

    expect(planAnswerSchema.parse(valid)).toEqual(valid);
    expect(() => planAnswerSchema.parse({ subtasks: [] })).toThrow(/Too small/u);
  });

  it("builds check and audit prompts that self-inspect the diff (never embed it)", () => {
    const check: CheckAnswer = {
      done: true,
      reason: "ok",
      suggested_fixes: null,
    };
    const baselineSha = "a".repeat(40);
    const checkPrompt = buildCheckPrompt({
      specTitle: "Fixture",
      specDescription: "Review a change",
      acceptanceCriteria: ["README includes ok"],
      baselineSha,
    });
    const auditPrompt = buildAuditPrompt({
      specTitle: "Fixture",
      acceptanceCriteria: ["README includes ok"],
      checkAnswer: check,
      baselineSha,
    });

    expect(checkPrompt).toContain("Do not edit files");
    expect(checkPrompt).toContain("README includes ok");
    expect(auditPrompt).toContain("Do not edit files");
    expect(auditPrompt).toContain('"done": true');

    // The diff is INSPECTED by the agent, never injected: the prompt carries the
    // baseline sha + a self-inspection instruction and no embedded diff payload.
    for (const prompt of [checkPrompt, auditPrompt]) {
      expect(prompt).toContain(baselineSha);
      expect(prompt).toContain(`git diff ${baselineSha} -- . ':(exclude)node_modules'`);
      expect(prompt).toContain("Inspect it yourself");
      expect(prompt).not.toContain("diff --git");
    }
  });
});
