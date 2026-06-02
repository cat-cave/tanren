// The Answerer schema catalog: the single source of truth mapping each role to
// its Zod schema, schema id, and generated JSON Schema file. Kept in its own
// module (rather than in `index.ts`) so both the barrel and `adapter.ts` can
// import it without `adapter.ts → index.ts → adapter.ts` forming an import
// cycle. This module imports only the leaf schema files.
import type { ZodType } from "zod";

import { AUDIT_ANSWER_SCHEMA_ID, AuditAnswer } from "./audit.js";
import { CHECK_ANSWER_SCHEMA_ID, CheckAnswer } from "./check.js";
import { CONFLICT_ANSWER_SCHEMA_ID, ConflictAnswer } from "./conflict.js";
import { DEMO_ANSWER_SCHEMA_ID, DemoAnswer } from "./demo.js";
import { FORGE_ANSWER_SCHEMA_ID, ForgeAnswer } from "./forge.js";
import { PLAN_ANSWER_SCHEMA_ID, PlanAnswer } from "./plan.js";
import { REVIEW_ANSWER_SCHEMA_ID, ReviewAnswer } from "./review.js";

export type AnswererRole = "plan" | "check" | "audit" | "demo" | "forge" | "review" | "conflict";

export interface AnswererSchemaDescriptor {
  readonly role: AnswererRole;
  readonly schemaId: string;
  readonly generatedFile: string;
  readonly zod: ZodType;
}

// answererSchemaCatalog drives both the codegen step
// (scripts/answerer-schema-export.ts) and the drift test
// (services/orchestrator/tests/answererSchemaDrift.test.ts). Order is part
// of the contract: keeping it stable keeps the generated file ordering
// stable for human-friendly diffs.
export const answererSchemaCatalog: Readonly<Record<AnswererRole, AnswererSchemaDescriptor>> = {
  plan: {
    role: "plan",
    schemaId: PLAN_ANSWER_SCHEMA_ID,
    generatedFile: "plan.json",
    zod: PlanAnswer,
  },
  check: {
    role: "check",
    schemaId: CHECK_ANSWER_SCHEMA_ID,
    generatedFile: "check.json",
    zod: CheckAnswer,
  },
  audit: {
    role: "audit",
    schemaId: AUDIT_ANSWER_SCHEMA_ID,
    generatedFile: "audit.json",
    zod: AuditAnswer,
  },
  demo: {
    role: "demo",
    schemaId: DEMO_ANSWER_SCHEMA_ID,
    generatedFile: "demo.json",
    zod: DemoAnswer,
  },
  forge: {
    role: "forge",
    schemaId: FORGE_ANSWER_SCHEMA_ID,
    generatedFile: "forge.json",
    zod: ForgeAnswer,
  },
  review: {
    role: "review",
    schemaId: REVIEW_ANSWER_SCHEMA_ID,
    generatedFile: "review.json",
    zod: ReviewAnswer,
  },
  conflict: {
    role: "conflict",
    schemaId: CONFLICT_ANSWER_SCHEMA_ID,
    generatedFile: "conflict.json",
    zod: ConflictAnswer,
  },
} as const;
