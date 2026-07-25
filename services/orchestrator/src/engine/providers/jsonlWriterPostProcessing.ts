import { createLogger } from "../observability/logger.js";
import type { JsonlObjectDecodeError } from "./findTokenUsage.js";
import type { WriterResult } from "./types.js";
const log = createLogger("jsonl-writer-post-processing");
type GitState = Pick<WriterResult, "diff" | "commits">;
type WriterTelemetry = NonNullable<WriterResult["telemetry"]>;
type JsonlWriterProvider = "claude" | "codex" | "opencode" | "reasonix";
type PostProcessingResult =
  | { gitState: GitState; failedResult?: never }
  | { gitState?: never; failedResult: WriterResult };
export async function postProcessPreservingJsonlFailure(
  provider: JsonlWriterProvider,
  telemetry: WriterTelemetry,
  postProcess: () => Promise<GitState>,
): Promise<PostProcessingResult> {
  if (telemetry.jsonlDecodeFailure === undefined) {
    return { gitState: await postProcess() };
  }
  const failedResult: WriterResult = {
    diff: "",
    commits: [],
    exitReason: "crashed",
    tokenUsage: telemetry.tokenUsage,
    telemetry,
  };
  try {
    return { failedResult: { ...failedResult, ...(await postProcess()) } };
  } catch {
    log.error("writer post-processing failed after JSONL decode failure; returning uncaptured Git evidence", {
      provider,
    });
    return { failedResult };
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
