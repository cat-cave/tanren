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

// A TRANSIENT answerer stall — the provider showed no sign of life within the
// ActivityWatchdog's liveness window (no streamed event, no workspace mutation) and the
// call was surfaced as stalled rather than producing an answer. This is NON-deterministic
// (the next identical call usually succeeds), so the loop-stage recovery wrapper RE-DRIVES
// the SAME stage with the SAME inputs instead of discarding the whole spec loop. It lives
// here (not in codex.ts) so codex.ts / claude.ts can throw it and the workflow-layer
// recovery helper can catch it WITHOUT an import cycle. The `schemaName` identifies which
// answerer stalled (the stable failure signature the convergence detector reasons over so a
// genuinely-wedged stage — a stall on EVERY re-drive — still escalates loudly, not a count).
export class AnswererStalledError extends Error {
  constructor(readonly schemaName: string) {
    super(`Answerer stalled (no sign of life) for schema ${schemaName}`);
    this.name = "AnswererStalledError";
  }
}
