import { describe, expect, it } from "vitest";

import { answererOutputSchemaFor } from "../src/engine/answerers/schemas/adapter.js";
import {
  AuditAnswer,
  CHECK_ANSWER_SCHEMA_ID,
  CheckAnswer,
  DEMO_ANSWER_SCHEMA_ID,
  DemoAnswer,
  FORGE_ANSWER_SCHEMA_ID,
  ForgeAnswer,
  PLAN_ANSWER_SCHEMA_ID,
  PlanAnswer,
  AUDIT_ANSWER_SCHEMA_ID,
} from "../src/engine/answerers/schemas/index.js";

// Adapter tests confirm the AnswererOutputSchema bridge surfaces the
// committed JSON Schema artifact (the file consumed by
// `codex exec --output-schema`) and round-trips through the Zod parser.

describe("answererOutputSchemaFor", () => {
  it("loads the generated JSON Schema mirror and exposes the canonical schema id for plan", () => {
    const schema = answererOutputSchemaFor("plan", PlanAnswer);
    expect(schema.name).toBe(PLAN_ANSWER_SCHEMA_ID);
    expect(schema.jsonSchema["x-tanren-schema-id"]).toBe(PLAN_ANSWER_SCHEMA_ID);
    expect(schema.jsonSchema.type).toBe("object");
    const parsed = schema.parse({
      subtasks: [{ index: 0, title: "t", intent: "i", behaviorIds: [], estimatedTokens: null }],
      rationale: "r",
    });
    expect(parsed.rationale).toBe("r");
  });

  it("bridges check, audit, demo, and forge schemas with their committed JSON Schema", () => {
    const check = answererOutputSchemaFor("check", CheckAnswer);
    expect(check.name).toBe(CHECK_ANSWER_SCHEMA_ID);
    expect(check.parse({ passed: true, reasoning: "ok", behaviorIdsPassed: [], behaviorIdsFailed: [] }).passed).toBe(
      true,
    );

    const audit = answererOutputSchemaFor("audit", AuditAnswer);
    expect(audit.name).toBe(AUDIT_ANSWER_SCHEMA_ID);
    expect(
      audit.parse({
        passed: true,
        reasoning: "ok",
        outstandingBehaviorIds: [],
        recommendedAction: "pass",
        // S3a: `findings` is REQUIRED (no default) — a clean audit emits an explicit [].
        findings: [],
      }).recommendedAction,
    ).toBe("pass");

    const demo = answererOutputSchemaFor("demo", DemoAnswer);
    expect(demo.name).toBe(DEMO_ANSWER_SCHEMA_ID);
    expect(demo.parse({ headline: "h", body: "b", highlightBehaviorIds: [] }).links).toEqual([]);

    const forge = answererOutputSchemaFor("forge", ForgeAnswer);
    expect(forge.name).toBe(FORGE_ANSWER_SCHEMA_ID);
    expect(forge.parse({ body: "b" }).attentionItems).toEqual([]);
  });

  it("rejects invalid output by surfacing the Zod parse error", () => {
    const schema = answererOutputSchemaFor("check", CheckAnswer);
    expect(() => schema.parse({ passed: "maybe" })).toThrow(/Invalid/u);
  });
});
