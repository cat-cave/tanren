// Forge conversation substrate schemas.
//
// `forge_threads` is the unit of operator-Forge conversation, scoped to an
// org (and optionally a project or run). `forge_turns` are append-only
// ordered records inside a thread. Each turn carries:
//   - source: what triggered the turn (an event, a cost record, an insight,
//     a prior turn, or an operator action)
//   - audience: the minimum access scope that can read the turn's render
//     payload; the read path through redaction respects this
//   - authorKind: `forge_template` (v0 fallback), `forge_llm` (the real-LLM
//     answerer), or `operator` (operator-typed message)
//   - render: the typed `ForgeAnswer` payload from the Forge
//
// The render payload is validated against the `ForgeAnswer` schema
// at append time; readers do not have to re-validate but receive a typed
// unknown that they can re-parse if they need exhaustive type safety.

import { z } from "zod";
import { ForgeAnswer } from "../answerers/schemas/forge.js";

export const ForgeThreadScope = z.enum(["org", "project", "run"]);
export type ForgeThreadScope = z.infer<typeof ForgeThreadScope>;

export const ForgeTurnSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), eventId: z.number().int() }).strict(),
  z.object({ kind: z.literal("cost"), costRecordId: z.number().int() }).strict(),
  z.object({ kind: z.literal("insight"), insightId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("prior_turn"), priorTurnId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("operator"), userId: z.string().min(1) }).strict(),
]);
export type ForgeTurnSource = z.infer<typeof ForgeTurnSource>;

export const ForgeTurnAudience = z.enum(["project:member", "project:admin", "org:admin", "platform:admin"]);
export type ForgeTurnAudience = z.infer<typeof ForgeTurnAudience>;

export const ForgeAuthorKind = z.enum(["forge_template", "forge_llm", "operator"]);
export type ForgeAuthorKind = z.infer<typeof ForgeAuthorKind>;

export const ForgeThreadRow = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
    scope: ForgeThreadScope,
    title: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    closedAt: z.date().nullable(),
  })
  .superRefine((row, ctx) => {
    // Scope-consistency mirrors the CHECK constraint in db/src/schema.ts so
    // a row that violates the invariant is rejected on read as well.
    if (row.scope === "org" && (row.projectId !== null || row.runId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "org-scoped thread must have null projectId and runId",
      });
    }
    if (row.scope === "project" && (row.projectId === null || row.runId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "project-scoped thread must have a projectId and null runId",
      });
    }
    if (row.scope === "run" && (row.projectId === null || row.runId === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "run-scoped thread must have both projectId and runId",
      });
    }
  });
export type ForgeThreadRow = z.infer<typeof ForgeThreadRow>;

export const ForgeTurnRow = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    index: z.number().int().nonnegative(),
    source: ForgeTurnSource,
    audience: ForgeTurnAudience,
    authorKind: ForgeAuthorKind,
    // render is the structured ForgeAnswer the dashboard will
    // render. We persist as unknown and validate explicitly on append so the
    // append path is the bottleneck; readers re-parse only if they need
    // typed access.
    render: z.unknown(),
    createdAt: z.date(),
  })
  .strict();
export type ForgeTurnRow = z.infer<typeof ForgeTurnRow>;

export const ForgeThreadCreateInput = z
  .object({
    id: z.string().min(1).optional(),
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable().default(null),
    runId: z.string().min(1).nullable().default(null),
    scope: ForgeThreadScope,
    title: z.string().nullable().default(null),
  })
  .superRefine((row, ctx) => {
    if (row.scope === "org" && (row.projectId !== null || row.runId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "org-scoped thread must have null projectId and runId",
      });
    }
    if (row.scope === "project" && (row.projectId === null || row.runId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "project-scoped thread must have a projectId and null runId",
      });
    }
    if (row.scope === "run" && (row.projectId === null || row.runId === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "run-scoped thread must have both projectId and runId",
      });
    }
  });
export type ForgeThreadCreateInput = z.infer<typeof ForgeThreadCreateInput>;

export const ForgeTurnAppendInput = z
  .object({
    id: z.string().min(1).optional(),
    threadId: z.string().min(1),
    source: ForgeTurnSource,
    audience: ForgeTurnAudience,
    authorKind: ForgeAuthorKind,
    // Validated against the ForgeAnswer schema in the store.
    render: ForgeAnswer,
  })
  .strict();
export type ForgeTurnAppendInput = z.infer<typeof ForgeTurnAppendInput>;

// Re-export the ForgeAnswer + its derivatives so downstream
// callers (route layer, narration generator) have a single import surface.
export { ForgeAnswer } from "../answerers/schemas/forge.js";
export type { ForgeAnswer as ForgeAnswerPayload } from "../answerers/schemas/forge.js";
