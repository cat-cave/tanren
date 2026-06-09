// The Answerer schema-validation error, in its own module so the schema-repair pass
// (answererRepair.ts) and the adapters (codex.ts / claude.ts) can all reference it
// WITHOUT an import cycle (answererRepair must not depend on codex, which depends on
// answererRepair). codex.ts re-exports it so existing `from "./codex.js"` importers
// are unaffected.
export class AnswererSchemaValidationError extends Error {
  constructor(schemaName: string, message: string) {
    super(`Answerer response failed ${schemaName} validation: ${message}`);
    this.name = "AnswererSchemaValidationError";
  }
}
