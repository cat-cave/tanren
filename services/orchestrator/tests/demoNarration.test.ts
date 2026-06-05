// demo-role narration tests. Cover the real-Answerer path (mocked,
// so no SSH/CLI is touched), the no-credential fallback, the live-failure
// fallback, prompt shape, and the adapter-selector resolution.

import { describe, expect, it } from "vitest";
import { DemoAnswer } from "../src/engine/answerers/schemas/index.js";
import {
  buildDemoPrompt,
  generateDemoNarration,
  templateDemoNarration,
  type DemoNarrationInput,
} from "../src/engine/demo/index.js";
import { buildDemoAnswererOrNull, type AdapterSelectorDependencies } from "../src/engine/providers/adapterSelector.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { emptyRoutingTable, RoutingTable } from "../src/engine/config/shared.js";

const baseInput: DemoNarrationInput = {
  specTitle: "Supplier onboarding flow",
  specDescription: "Let an operator invite a supplier and track their first order.",
  behaviors: [
    {
      id: "beh_invite",
      title: "Invite a supplier",
      scenario: "Given an operator, when they send an invite, then the supplier receives it.",
    },
    { id: "beh_order", title: "Track first order", scenario: "" },
  ],
  prUrl: "https://github.com/example/repo/pull/207",
  unresolvedRisks: ["Email delivery not yet load-tested"],
  timeoutMs: 1_000,
};

class RecordingAnswerer implements AnswererAdapter<DemoAnswer> {
  readonly kind = "answerer";
  readonly cli = "codex";
  readonly authRef = "credential/codex/demo-test";
  lastSchemaName: string | undefined;
  lastPrompt: string | undefined;

  constructor(private readonly output: DemoAnswer) {}

  async runAnswerer(opts: Parameters<AnswererAdapter<DemoAnswer>["runAnswerer"]>[0]): Promise<DemoAnswer> {
    this.lastSchemaName = opts.outputSchema.name;
    this.lastPrompt = opts.prompt;
    // Parse through the supplied schema to mirror a real adapter so the test
    // also exercises the contract end-to-end.
    return opts.outputSchema.parse(this.output);
  }
}

class ThrowingAnswerer implements AnswererAdapter<DemoAnswer> {
  readonly kind = "answerer";
  readonly cli = "claude";
  readonly authRef = "credential/claude/demo-test";
  async runAnswerer(): Promise<DemoAnswer> {
    throw new Error("simulated usage-limit / CLI failure");
  }
}

describe("demo-role narration (P3-0011)", () => {
  it("real-Answerer path (mocked) produces narration from the live call", async () => {
    const llmAnswer: DemoAnswer = {
      headline: "Suppliers can now be invited and tracked end-to-end",
      body: "The run wired up the invite flow and first-order tracking against the spec.",
      highlightBehaviorIds: ["beh_invite", "beh_order"],
      showStopperRisks: ["Email delivery not yet load-tested"],
      links: [{ label: "Open PR", url: "https://github.com/example/repo/pull/207" }],
    };
    const answerer = new RecordingAnswerer(llmAnswer);

    const result = await generateDemoNarration(answerer, baseInput);

    expect(result.provenance).toBe("answerer");
    expect(result.schemaId).toBe("tanren.demo_answer.v1");
    expect(result.answer).toEqual(llmAnswer);
    // The Answerer was invoked with the demo schema.
    expect(answerer.lastSchemaName).toBe("tanren.demo_answer.v1");
    // The prompt carries the spec + behaviors + risk + PR context.
    expect(answerer.lastPrompt).toContain("Supplier onboarding flow");
    expect(answerer.lastPrompt).toContain("beh_invite");
    expect(answerer.lastPrompt).toContain("Email delivery not yet load-tested");
  });

  it("falls back to the template when no credential / adapter is available", async () => {
    const result = await generateDemoNarration(null, baseInput);

    expect(result.provenance).toBe("template");
    expect(result.schemaId).toBe("tanren.demo_answer.v1");
    // The fallback still satisfies the DemoAnswer schema and carries content.
    expect(() => DemoAnswer.parse(result.answer)).not.toThrow();
    expect(result.answer.headline).toContain("Supplier onboarding flow");
    expect(result.answer.highlightBehaviorIds).toEqual(["beh_invite", "beh_order"]);
    expect(result.answer.showStopperRisks).toEqual(["Email delivery not yet load-tested"]);
    expect(result.answer.links).toEqual([{ label: "Open PR", url: "https://github.com/example/repo/pull/207" }]);
  });

  it("falls back to the template when the live Answerer throws", async () => {
    const result = await generateDemoNarration(new ThrowingAnswerer(), baseInput);

    expect(result.provenance).toBe("template");
    expect(() => DemoAnswer.parse(result.answer)).not.toThrow();
  });

  it("templateDemoNarration degrades gracefully with no behaviors/risks/PR", () => {
    const answer = templateDemoNarration({
      specTitle: "Bare spec",
      specDescription: "Nothing fancy.",
      behaviors: [],
      unresolvedRisks: [],
      timeoutMs: 1_000,
    });
    expect(answer.headline).toBe("Completed: Bare spec");
    expect(answer.highlightBehaviorIds).toEqual([]);
    expect(answer.showStopperRisks).toEqual([]);
    expect(answer.links).toEqual([]);
  });

  it("buildDemoPrompt renders the schema-shape instructions", () => {
    const prompt = buildDemoPrompt(baseInput);
    expect(prompt).toContain("highlightBehaviorIds");
    expect(prompt).toContain("showStopperRisks");
    expect(prompt).toContain('labelled "Open PR"');
  });
});

describe("buildDemoAnswererOrNull (P3-0011 selector)", () => {
  const deps: AdapterSelectorDependencies = {
    secrets: {} as AdapterSelectorDependencies["secrets"],
    ssh: {} as AdapterSelectorDependencies["ssh"],
    target: {} as AdapterSelectorDependencies["target"],
    runId: "run_demo_test",
  };

  it("returns null when the demo chain is empty (default — no credential)", () => {
    expect(buildDemoAnswererOrNull(deps, emptyRoutingTable())).toBeNull();
  });

  it("defaults to the Codex Answerer when the demo chain heads with codex", () => {
    const routing = RoutingTable.parse({
      demo: { chain: [{ cli: "codex", model: "gpt-5-codex", authRef: "credential/codex/demo" }] },
    });
    const answerer = buildDemoAnswererOrNull(deps, routing);
    expect(answerer).not.toBeNull();
    expect(answerer?.cli).toBe("codex");
    expect(answerer?.authRef).toBe("credential/codex/demo");
  });

  it("selects the Claude Answerer when the demo chain heads with claude", () => {
    const routing = RoutingTable.parse({
      demo: {
        chain: [{ cli: "claude", model: "claude-opus-4", authRef: "credential/claude/demo" }],
      },
    });
    const answerer = buildDemoAnswererOrNull(deps, routing);
    expect(answerer?.cli).toBe("claude");
  });
});
