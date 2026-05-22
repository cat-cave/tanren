import { describe, expect, it } from "vitest";
import {
  auditAnswerSchema,
  buildAuditPrompt,
  buildCheckPrompt,
  checkAnswerSchema,
  planAnswerSchema,
  type CheckAnswer
} from "../src/engine/providers/answererSchemas.js";

describe("structured Answerer schemas", () => {
  it("validates check answers strictly", () => {
    const valid = {
      done: true,
      reason: "The diff satisfies the spec.",
      suggested_fixes: null
    };

    expect(checkAnswerSchema.parse(valid)).toEqual(valid);
    expect(() => checkAnswerSchema.parse({ ...valid, extra: "nope" })).toThrow(/Unrecognized key/);
    expect(() => checkAnswerSchema.parse({ ...valid, done: "maybe" })).toThrow(/Invalid input/);
  });

  it("validates audit answers strictly", () => {
    const valid = {
      verified: true,
      criteria_status: {
        criteria: [{ criterion: "Adds marker file", satisfied: true, reason: "The diff adds MARKER.md." }]
      },
      reason: "The check is complete."
    };

    expect(auditAnswerSchema.parse(valid)).toEqual(valid);
    expect(() => auditAnswerSchema.parse({ ...valid, unknown: true })).toThrow(/Unrecognized key/);
    expect(() =>
      auditAnswerSchema.parse({ ...valid, criteria_status: { criteria: [{ criterion: "", satisfied: true, reason: "ok" }] } })
    ).toThrow(/Too small/);
  });

  it("validates plan answers with acceptance criteria", () => {
    const valid = {
      subtasks: [{ title: "Add marker", acceptanceCriteria: ["README includes ok"] }]
    };

    expect(planAnswerSchema.parse(valid)).toEqual(valid);
    expect(() => planAnswerSchema.parse({ subtasks: [] })).toThrow(/Too small/);
  });

  it("builds check and audit prompts that reject mutation duties", () => {
    const check: CheckAnswer = {
      done: true,
      reason: "ok",
      suggested_fixes: null
    };
    const checkPrompt = buildCheckPrompt({
      specTitle: "Fixture",
      specDescription: "Review a diff",
      acceptanceCriteria: ["README includes ok"],
      writerDiff: "diff --git a/README.md b/README.md\n+ok\n"
    });
    const auditPrompt = buildAuditPrompt({
      specTitle: "Fixture",
      acceptanceCriteria: ["README includes ok"],
      checkAnswer: check,
      writerDiff: "diff --git a/README.md b/README.md\n+ok\n"
    });

    expect(checkPrompt).toContain("Do not edit files");
    expect(checkPrompt).toContain("README includes ok");
    expect(auditPrompt).toContain("Do not edit files");
    expect(auditPrompt).toContain('"done": true');
  });
});
