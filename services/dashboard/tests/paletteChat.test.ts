// P3-0010: thick-Forge chat island — action-card routing logic.
//
// `routeForAction` is the seam that decides whether a ForgeAnswer action
// renders as an AUTO-NAVIGATE card (read tools → in-shell route). Write tools
// return undefined: they are NOT navigation actions — proposed writes render as
// live approve/reject proposal cards instead (P3-0010 write-action approval,
// covered by forgeProposalClient.test.ts). Unit-tested directly (no DOM).

import { describe, expect, it } from "vitest";
import { routeForAction } from "../src/client/paletteChat.js";

describe("routeForAction (Forge chat action cards)", () => {
  it("maps read_run to the run route (auto-navigate)", () => {
    expect(
      routeForAction({
        label: "Open run",
        toolCall: { tool: "tanren.read_run", args: { runId: "run_9" } },
      }),
    ).toBe("/runs/run_9");
  });

  it("maps read_spec to the spec route", () => {
    expect(
      routeForAction({
        label: "Open spec",
        toolCall: { tool: "tanren.read_spec", args: { specId: "spec_1" } },
      }),
    ).toBe("/specs/spec_1");
  });

  it("maps read_costs to the costs view", () => {
    expect(
      routeForAction({
        label: "Costs",
        toolCall: { tool: "tanren.read_costs", args: { runId: "run_9" } },
      }),
    ).toBe("/costs");
  });

  it("maps read_insights / read_milestones to the overview", () => {
    expect(
      routeForAction({
        label: "Insights",
        toolCall: { tool: "tanren.read_insights", args: { projectId: "p" } },
      }),
    ).toBe("/overview");
  });

  it("returns undefined for WRITE tools (rendered as proposal cards, not nav)", () => {
    expect(
      routeForAction({
        label: "Create spec",
        toolCall: {
          tool: "tanren.create_spec",
          args: { projectId: "p", title: "t", description: "d" },
        },
      }),
    ).toBeUndefined();
    expect(
      routeForAction({
        label: "Trigger run",
        toolCall: { tool: "tanren.trigger_run", args: { specId: "s" } },
      }),
    ).toBeUndefined();
    expect(
      routeForAction({
        label: "Rerun",
        toolCall: { tool: "tanren.rerun_task", args: { taskId: "task_1" } },
      }),
    ).toBeUndefined();
  });
});
