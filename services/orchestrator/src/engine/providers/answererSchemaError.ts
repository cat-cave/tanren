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

import type { Failure } from "../failure.js";
import { isTransientSshConnectError } from "../ssh/transientRetry.js";

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

// SHARED SEAM (apex v37): if a command result's failure is a TRANSIENT SSH/transport
// CONNECT failure — an `ssh_failed` whose handshake could not ESTABLISH within the connect
// window because the runner was momentarily saturated (it recovers in seconds) — throw the
// typed transient `AnswererStalledError` so EVERY answerer-call consumer treats it uniformly
// as recoverable: the spec-loop's `loopStageRecovery` RE-DRIVES the stage, and the pre-build
// template-creation retry (`withAnswererRetry`) tolerates it — never a terminal halt. A
// non-self-healing failure (a host-key fingerprint mismatch, an auth/permission failure) is
// EXCLUDED by the shared classifier and falls through to the caller's loud terminal throw.
// Both the codex + claude answerer adapters call this at the SAME point in their failure
// handling, so the transient-vs-terminal classification lives in ONE place, not scattered.
export function throwIfTransientSshFailure(failure: Failure | undefined, schemaName: string): void {
  if (failure?.kind === "ssh_failed" && isTransientSshConnectError(new Error(failure.message))) {
    throw new AnswererStalledError(schemaName);
  }
}
