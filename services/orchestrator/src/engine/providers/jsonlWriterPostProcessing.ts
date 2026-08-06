import { createLogger } from "../observability/logger.js";
import type { JsonlObjectDecodeError } from "./findTokenUsage.js";
import type { WriterResult } from "./types.js";
const log = createLogger("jsonl-writer-post-processing");
type GitState = Pick<WriterResult, "diff" | "commits">;
type WriterTelemetry = NonNullable<WriterResult["telemetry"]>;
type JsonlWriterProvider = "claude" | "codex" | "opencode" | "reasonix";
// Runs the writer's git-capture post-processing and returns the captured git
// state. A JSONL decode failure is TERMINAL for a completed run, but the caller
// classifies it AFTER the recoverable stall / usage-limit checks — so a transient
// stall that left partial (truncated, hence malformed) stdout is reported as the
// recoverable `timeout`/`window_exhausted` the recovery layer re-drives, NOT a
// terminal `crashed`. When a decode failure is present we still capture git
// evidence best-effort, tolerating a capture failure (returning empty git state)
// so the decode-failure telemetry is never lost.
export async function postProcessPreservingJsonlFailure(
  provider: JsonlWriterProvider,
  telemetry: WriterTelemetry,
  postProcess: () => Promise<GitState>,
): Promise<GitState> {
  if (telemetry.jsonlDecodeFailure === undefined) {
    return await postProcess();
  }
  try {
    return await postProcess();
  } catch {
    log.error("writer post-processing failed after JSONL decode failure; returning uncaptured Git evidence", {
      provider,
    });
    return { diff: "", commits: [] };
  }
}
export async function postProcessAnswererPreservingJsonlFailure(
  failure: JsonlObjectDecodeError | undefined,
  postProcess: () => Promise<void>,
): Promise<void> {
  try {
    await postProcess();
  } catch (error) {
    throw failure ?? error;
  }
  if (failure !== undefined) throw failure;
}
