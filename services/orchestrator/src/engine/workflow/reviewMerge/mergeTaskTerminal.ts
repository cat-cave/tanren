// AUDIT FINDING #5 — `writer` is non-optional + the legacy no-writer fallback arm is GONE.
// The prior shape branched on `if (writer !== undefined)` and split row UPDATE + event
// append into two separate writes on the absent-writer arm, defeating the §1c
// single-finalize invariant the helper exists to enforce. Production has ALWAYS wired
// the writer; the fallback existed only to keep the old split shape compilable for tests
// (which now wire a writer, or assert on the writer's recorded calls). Caller sites that
// lack a writer FAIL LOUD before this helper is called (the dispatcher's finalize asserts
// at its boundary).
import type { RunStateWriter } from "../../contracts/runStateWriter.js";

export interface MergeTaskTerminalBase {
  runId: string;
  specId: string;
  projectId: string;
  taskId: string;
}

export async function markMergeTaskDoneWithEvent(input: {
  writer: RunStateWriter;
  base: MergeTaskTerminalBase;
  integration: string;
}): Promise<void> {
  const { writer, base, integration } = input;
  await writer.updateTaskWithEvent({
    task: { taskId: base.taskId, transition: "done", outcome: "ok" },
    event: {
      ...base,
      eventType: "task.completed",
      payload: { taskKind: "merge", status: integration } as never,
    },
  });
}

export async function markMergeTaskFailedWithEvent(input: {
  writer: RunStateWriter;
  base: MergeTaskTerminalBase;
  failureKind: string;
}): Promise<void> {
  const { writer, base, failureKind } = input;
  await writer.updateTaskWithEvent({
    task: { taskId: base.taskId, transition: "failed_with_kind", failureKind },
    event: {
      ...base,
      eventType: "task.failed",
      payload: { taskKind: "merge", failureKind } as never,
    },
  });
}
