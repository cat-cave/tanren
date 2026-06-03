import { describe, expect, it } from "vitest";
import { auditAnswerSchema, checkAnswerSchema, planAnswerSchema } from "../src/engine/providers/answererSchemas.js";

// NOTE: the Checker/Auditor PROMPT TEXT is single-sourced in
// engine/workflow/answererPrompts.ts; its rendered-contract tests live in
// answererPrompts.test.ts (shared) + runloopPrompts.test.ts (production
// wrappers). This file covers only the structured OUTPUT SCHEMAS.
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
});
