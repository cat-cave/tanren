import type { RunnerAllocation } from "../contracts/allocator.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { createFakeWriter } from "../providers/fake.js";
import type { WriterResult } from "../providers/types.js";

export async function executeWriteTask(input: {
  allocation: RunnerAllocation;
  prompt: string;
  ssh: SshSubstrate;
  timeoutMs: number;
  workspacePath: string;
}): Promise<WriterResult> {
  const fakeWriter = createFakeWriter({ ssh: input.ssh, target: input.allocation.target });
  return await fakeWriter.runWriter({
    prompt: input.prompt,
    workspace: input.workspacePath,
    timeoutMs: input.timeoutMs
  });
}
