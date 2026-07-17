import { describe, expect, it } from "vitest";
import type { SetRunStatusInput } from "../src/engine/contracts/runStateWriter.js";
import { applySetRunStatus } from "../src/engine/worker/runStateLifecycleSql.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { markRunRunning } from "../src/engine/workflow/plannerRunFinalize.js";

describe("markRunRunning", () => {
  it("can only replace queued or running states, never a terminal run", async () => {
    const writes: SetRunStatusInput[] = [];
    const writer = {
      async setRunStatus(input: SetRunStatusInput): Promise<void> {
        writes.push(input);
      },
    };
    await markRunRunning(
      { runStateWriter: writer } as RunPlannerLoopInput,
      { runId: "run_terminal", orgId: "org_1" } as PlannerRunContext,
    );

    expect(writes).toEqual([
      {
        runId: "run_terminal",
        orgId: "org_1",
        status: "running",
        setStartedAt: true,
        fromStatuses: ["queued", "running"],
      },
    ]);

    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    let storedStatus = "failed";
    await applySetRunStatus(
      {
        async query(sql, params) {
          queries.push({ sql, params });
          const fromStatuses = (params?.[2] as string[] | undefined) ?? [];
          if (fromStatuses.includes(storedStatus)) {
            storedStatus = String(params?.[1]);
            return { rowCount: 1 };
          }
          return { rowCount: 0 };
        },
      },
      writes[0]!,
    );
    expect(queries[0]?.sql).toContain("status = ANY($3::text[])");
    expect(queries[0]?.params?.[2]).toEqual(["queued", "running"]);
    expect(storedStatus).toBe("failed");
  });
});
