// thick-Forge chat island — action-card routing logic + CSRF header helper.
//
// `routeForAction` is the seam that decides whether a ForgeAnswer action
// renders as an AUTO-NAVIGATE card (read tools → in-shell route). Write tools
// return undefined: they are NOT navigation actions — proposed writes render as
// live approve/reject proposal cards instead (write-action approval,
// covered by forgeProposalClient.test.ts). Unit-tested directly (no DOM).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askForge,
  csrfWriteHeaders,
  decideProposal,
  forgeToolFailureMessage,
  injectFormCsrfFields,
  routeForAction,
} from "../src/client/paletteChat.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("csrfWriteHeaders (palette island)", () => {
  it("attaches x-csrf-token when a shell token is provided", () => {
    const headers = csrfWriteHeaders("shell-csrf");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-csrf-token"]).toBe("shell-csrf");
  });

  it("omits x-csrf-token when token is empty (local-dev actor)", () => {
    const headers = csrfWriteHeaders("");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-csrf-token"]).toBeUndefined();
  });
});

describe("injectFormCsrfFields (progressive form enhancement)", () => {
  it("injects hidden csrf into POST forms from shell meta", () => {
    // Minimal DOM stub — enough for querySelector / createElement / appendChild.
    const inputs: Array<{ name: string; value: string; type: string }> = [];
    const form = {
      getAttribute: (name: string) => (name === "method" ? "post" : null),
      querySelector: () => null,
      append: (el: { name: string; value: string; type: string }) => {
        inputs.push(el);
      },
    };
    const meta = { getAttribute: (n: string) => (n === "content" ? "meta-csrf" : null) };
    const doc = {
      querySelector: (sel: string) => (sel === 'meta[name="csrf-token"]' ? meta : null),
      querySelectorAll: (sel: string) => (sel === "form" ? [form] : []),
      createElement: () => ({ type: "", name: "", value: "" }),
      body: { dataset: {} as Record<string, string> },
    };
    injectFormCsrfFields(doc as unknown as Document);
    expect(inputs).toEqual([{ type: "hidden", name: "csrf", value: "meta-csrf" }]);
  });

  it("skips forms that already carry a csrf field", () => {
    let appended = 0;
    // querySelector non-null ⇒ form already has a csrf input.
    const existingField = {};
    const form = {
      getAttribute: () => "post",
      querySelector: () => existingField,
      append: () => {
        appended += 1;
      },
    };
    const meta = { getAttribute: () => "meta-csrf" };
    const doc = {
      querySelector: (sel: string) => (sel === 'meta[name="csrf-token"]' ? meta : null),
      querySelectorAll: () => [form],
      createElement: () => ({ type: "", name: "", value: "" }),
      body: { dataset: {} as Record<string, string> },
    };
    injectFormCsrfFields(doc as unknown as Document);
    expect(appended).toBe(0);
  });
});

describe("forgeToolFailureMessage (palette error surface)", () => {
  it("surfaces HTTP status so operators never see a silent close", () => {
    expect(forgeToolFailureMessage(403)).toBe("Tool failed (403) — try again.");
    expect(forgeToolFailureMessage(0)).toBe("Tool failed — try again.");
  });
});

describe("askForge (palette error surface)", () => {
  it("returns a user-visible failure message for BFF errors", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "forge_ask_failed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await askForge("org_a", "what is blocked?", {});
    expect("error" in result ? result.error : "").toContain("Forge ask failed (502): forge_ask_failed");
  });

  it("fails closed on 200 {} (incomplete success body)", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await askForge("org_a", "what is blocked?", {});
    expect("error" in result ? result.error : "").toContain("incomplete response body");
  });

  it("fails closed on 200 JSON null", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("null", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await askForge("org_a", "what is blocked?", {});
    expect("error" in result ? result.error : "").toContain("incomplete response body");
  });
});

describe("decideProposal (fail-closed incomplete success)", () => {
  it("200 {} does not fabricate executed/rejected success", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await decideProposal("org_a", "prop_1", "approve");
    expect(result.status).toBe("failed");
    expect(result.message).toContain("incomplete response body");
  });

  it("200 with proposal.status returns that status", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ proposal: { status: "executed" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await decideProposal("org_a", "prop_1", "approve");
    expect(result).toEqual({ status: "executed" });
  });
});
