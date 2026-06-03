import { z } from "zod";

export interface AnswererOutputSchema<TOutput> {
  name: string;
  jsonSchema: Record<string, unknown>;
  parse(value: unknown): TOutput;
}

const planSubtaskSchema = z
  .object({
    title: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
  })
  .strict();

const criterionStatusSchema = z
  .object({
    criterion: z.string().min(1),
    satisfied: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();

export const planAnswerZodSchema = z
  .object({
    subtasks: z.array(planSubtaskSchema).min(1),
  })
  .strict();

export const checkAnswerZodSchema = z
  .object({
    done: z.boolean(),
    reason: z.string().min(1),
    suggested_fixes: z.array(z.string().min(1)).nullable(),
  })
  .strict();

export const auditAnswerZodSchema = z
  .object({
    verified: z.boolean(),
    criteria_status: z
      .object({
        criteria: z.array(criterionStatusSchema).min(1),
      })
      .strict(),
    reason: z.string().min(1),
  })
  .strict();

export type PlanAnswer = z.infer<typeof planAnswerZodSchema>;
export type CheckAnswer = z.infer<typeof checkAnswerZodSchema>;
export type AuditAnswer = z.infer<typeof auditAnswerZodSchema>;

export const planAnswerSchema: AnswererOutputSchema<PlanAnswer> = {
  name: "tanren.plan_answer.v1",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["subtasks"],
    properties: {
      subtasks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "acceptanceCriteria"],
          properties: {
            title: { type: "string", minLength: 1 },
            acceptanceCriteria: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  },
  parse(value) {
    return planAnswerZodSchema.parse(value);
  },
};

export const checkAnswerSchema: AnswererOutputSchema<CheckAnswer> = {
  name: "tanren.check_answer.v1",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["done", "reason", "suggested_fixes"],
    properties: {
      done: { type: "boolean" },
      reason: { type: "string", minLength: 1 },
      suggested_fixes: {
        anyOf: [{ type: "array", items: { type: "string", minLength: 1 } }, { type: "null" }],
      },
    },
  },
  parse(value) {
    return checkAnswerZodSchema.parse(value);
  },
};

export const auditAnswerSchema: AnswererOutputSchema<AuditAnswer> = {
  name: "tanren.audit_answer.v1",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["verified", "criteria_status", "reason"],
    properties: {
      verified: { type: "boolean" },
      criteria_status: {
        type: "object",
        additionalProperties: false,
        required: ["criteria"],
        properties: {
          criteria: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["criterion", "satisfied", "reason"],
              properties: {
                criterion: { type: "string", minLength: 1 },
                satisfied: { type: "boolean" },
                reason: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
      reason: { type: "string", minLength: 1 },
    },
  },
  parse(value) {
    return auditAnswerZodSchema.parse(value);
  },
};

// NOTE: the Checker/Auditor PROMPT TEXT is single-sourced in
// `engine/workflow/answererPrompts.ts` (shared by the production run path and
// the structured-task path). This module owns only the OUTPUT SCHEMAS above.
