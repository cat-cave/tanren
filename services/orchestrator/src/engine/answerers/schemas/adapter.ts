// Bridges the typed Phase 2 Answerer schemas (Zod source of truth) to the
// `AnswererOutputSchema` interface accepted by the existing Codex Answerer
// adapter (`services/orchestrator/src/engine/providers/codex.ts`). The
// generated JSON Schema files under `generated/` are the canonical artifact
// that `codex exec --output-schema` consumes; this helper loads that mirror
// at runtime so a future cutover from Phase 1 schemas (P2A-0012, P2A-0019)
// can swap callers over without re-stating the JSON Schema in code.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ZodType } from "zod";

import {
  answererSchemaCatalog,
  type AnswererRole
} from "./catalog.js";

export interface AnswererOutputSchema<TOutput> {
  name: string;
  jsonSchema: Record<string, unknown>;
  parse(value: unknown): TOutput;
}

const generatedDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "generated"
);

function loadGeneratedJsonSchema(role: AnswererRole): Record<string, unknown> {
  const descriptor = answererSchemaCatalog[role];
  const file = resolve(generatedDir, descriptor.generatedFile);
  const text = readFileSync(file, "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

// answererOutputSchemaFor returns the `AnswererOutputSchema` value passed to
// `codex exec --output-schema` callers. The committed JSON Schema mirror is
// the artifact the Codex CLI sees; the Zod source is the parser. The drift
// test keeps them aligned.
export function answererOutputSchemaFor<TOutput>(
  role: AnswererRole,
  zodSchema: ZodType<TOutput>
): AnswererOutputSchema<TOutput> {
  const descriptor = answererSchemaCatalog[role];
  return {
    name: descriptor.schemaId,
    jsonSchema: loadGeneratedJsonSchema(role),
    parse(value): TOutput {
      return zodSchema.parse(value);
    }
  };
}
