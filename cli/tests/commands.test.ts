import { afterEach, describe, expect, it, vi } from "vitest";
import { status } from "../src/main.js";

describe("cli package", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("has a test harness", () => {
    expect(process.version.startsWith("v")).toBe(true);
  });

  it("prints run status with ordered tasks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            run: { run_id: "run_1", status: "done" },
            tasks: [
              { task_id: "task_plan", kind: "plan", status: "done" },
              { task_id: "task_write", kind: "write", status: "done" }
            ],
            events: [],
            costs: []
          }),
          { status: 200 }
        );
      })
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await status("run_1");

    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          run: { run_id: "run_1", status: "done" },
          tasks: [
            { task_id: "task_plan", kind: "plan", status: "done" },
            { task_id: "task_write", kind: "write", status: "done" }
          ],
          events: [],
          costs: []
        },
        null,
        2
      )
    );
  });
});
