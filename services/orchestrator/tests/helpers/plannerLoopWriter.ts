// Audit finding D3/H3 sweep: the planner-loop helpers' default `RunStateWriter`
// for unit tests. Forwards the writer's `append` calls back into the shared
// `events` recorder AND forwards task INSERTs/UPDATEs + setRunAuthRef back into
// the `FakePool`'s state, so existing per-test assertions on `pool.tasks` /
// `pool.runsAuthRefStamps` / `events.events` keep holding unchanged.
//
// Extracted from `plannerLoopHelpers.ts` to keep that file under the 500-line
// architecture cap.
import type { FakePool } from "./plannerLoopHelpers.js";
import type { FakeEventStore } from "./fakeEventStore.js";
import { InMemoryRunStateWriter } from "../fixtures/inMemoryRunStateWriter.js";

export function buildLoopWriter(pool: FakePool, events: FakeEventStore): InMemoryRunStateWriter {
  return new InMemoryRunStateWriter({
    forwardAppend: (input) => events.append(input),
    forwardInsertTask: (input) => {
      pool.tasks.push({
        taskId: input.taskId,
        runId: input.runId,
        kind: input.kind,
        title: input.title,
        parentTaskId: input.parentTaskId ?? null,
        status: input.status,
        outcome: null,
        failureKind: null,
        cli: input.cli,
      });
    },
    forwardUpdateTask: (input) => {
      const task = pool.tasks.find((t) => t.taskId === input.taskId);
      if (task === undefined) return;
      if (input.transition === "done") {
        task.status = "done";
        task.outcome = input.outcome ?? "ok";
      } else if (
        input.transition === "failed" ||
        input.transition === "failed_with_kind" ||
        (input.transition === "failed_with_kind_if_running" && task.status === "running")
      ) {
        task.status = "failed";
        task.outcome = "failed";
        task.failureKind = input.failureKind ?? task.failureKind;
      } else if (input.transition === "running" || input.transition === "started") {
        task.status = "running";
      }
    },
    forwardSetRunAuthRef: (input) => {
      pool.runsAuthRefStamps.push({ runId: input.runId, authRef: input.authRef });
    },
  });
}
