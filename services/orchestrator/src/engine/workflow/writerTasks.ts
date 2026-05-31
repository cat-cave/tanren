import type { WriterAdapter, WriterResult } from "../providers/types.js";

/**
 * Run the write stage with the writer adapter the caller resolved. The adapter
 * is ALWAYS supplied by the caller — the real run path passes the role-routing
 * selected writer (Codex by default; Claude/opencode purely by routing data),
 * and the synthetic hello-connectivity fixture passes its fixture writer. No
 * writer is constructed in here, so production can never hardcode a fake.
 */
export async function executeWriteTask(input: {
  writer: WriterAdapter;
  prompt: string;
  timeoutMs: number;
  workspacePath: string;
}): Promise<WriterResult> {
  return await input.writer.runWriter({
    prompt: input.prompt,
    workspace: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });
}
