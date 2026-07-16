import { describe, expect, it } from "vitest";
import type pg from "pg";
import type {
  RecoveryPreparationInput,
  RecoveryPreparationWriter,
} from "../src/engine/contracts/recoveryPreparation.js";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import { buildReplanEnqueuer } from "../src/engine/workflow/reviewMerge/conflictResolver/replanEnqueuerPg.js";

describe("buildReplanEnqueuer atomic writer routing", () => {
  it("delegates the full unit once and never writes on the data-plane pool", async () => {
    const calls: RecoveryPreparationInput[] = [];
    const writer = {
      async prepareRecovery(input: RecoveryPreparationInput) {
        calls.push(input);
        return {
          kind: "owned" as const,
          newlyPrepared: true,
          receipt: {
            kind: "planner_replan" as const,
            specId: input.specId,
            run: { kind: "enqueued" as const, replanRunId: "run_new", plannerTaskId: "task_new" },
          },
        };
      },
      readRecoveryPreparation: () => Promise.reject(new Error("unexpected readback")),
    } as unknown as RunStateWriter & RecoveryPreparationWriter;
    const queries: string[] = [];
    const pool = {
      query(sql: string) {
        queries.push(sql);
        return Promise.resolve({ rows: [] });
      },
    } as unknown as pg.Pool;
    const enqueuer = buildReplanEnqueuer(pool, writer);

    const outcome = await enqueuer.enqueue({
      orgId: "org_test",
      projectId: "project_test",
      specId: "spec_test",
      oldRunId: "run_old",
      queueId: "queue_old",
      steeringNote: "fix the integrated gate",
      reopenStatus: "open",
      route: {
        kind: "planner_replan",
        newContext: "new base",
        conflictSignature: "signature",
      },
    });

    expect(outcome.kind).toBe("owned");
    expect(calls).toEqual([
      {
        orgId: "org_test",
        projectId: "project_test",
        specId: "spec_test",
        oldRunId: "run_old",
        queueId: "queue_old",
        steeringNote: "fix the integrated gate",
        reopenStatus: "open",
        route: {
          kind: "planner_replan",
          newContext: "new base",
          conflictSignature: "signature",
        },
      },
    ]);
    expect(queries).toEqual([]);
  });
});
