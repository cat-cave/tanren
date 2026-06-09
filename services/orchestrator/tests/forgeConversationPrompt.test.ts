// Mutation ratchet (test/mutation-ratchet-forge): behavior-based coverage of the
// Forge conversation PROMPT builder and the ANSWERER normalization / scripted
// fake. These two modules were the weakest in the Forge cluster (prompt.ts 0%,
// answerer.ts 23%) because the engine tests drive a fake answerer that bypasses
// `buildForgePrompt` and never exercises the read-tool-only `normalizeStep`
// filter at the answerer boundary. Every assertion here is on the real
// observable output (the rendered prompt string, the steps the answerer returns)
// — no mocks, no spy-call assertions.

import { describe, expect, it } from "vitest";
import { ForgeAnswer } from "../src/engine/answerers/schemas/forge.js";
import {
  buildForgePrompt,
  wrapProviderAnswerer,
  ForgeAnswererStepSchema,
  type ForgeAnswererStep,
  type ForgeAnswererStepOutput,
  type ForgeConversationContext,
} from "../src/engine/forge/conversation/index.js";
import { createFakeForgeAnswerer } from "./fixtures/forge/fakeForgeAnswerer.js";
import type { ForgeTurnRow } from "../src/engine/forge/schemas.js";

// Narrow a step to a `tools` variant (throws if it is not) so assertions on the
// filtered tool calls are unconditional (the lint forbids conditional expects).
function asTools(step: ForgeAnswererStep): Extract<ForgeAnswererStep, { kind: "tools" }> {
  if (step.kind !== "tools") throw new Error(`expected a tools step, got ${step.kind}`);
  return step;
}

function asFinal(step: ForgeAnswererStep): Extract<ForgeAnswererStep, { kind: "final" }> {
  if (step.kind !== "final") throw new Error(`expected a final step, got ${step.kind}`);
  return step;
}

// A minimal AnswererAdapter stub that echoes a scripted provider output back
// through the wrapper. No provider is contacted; the wrapper builds a prompt,
// parses the output, and applies the read-tool-only filter. Module-scoped so it
// is not recreated per test.
function adapterReturning(output: ForgeAnswererStepOutput) {
  return {
    async runAnswerer(req: { prompt: string; outputSchema: { parse: (value: unknown) => ForgeAnswererStepOutput } }) {
      // The wrapper must hand us a non-empty prompt built from the context.
      expect(req.prompt).toContain("You are Forge");
      // The wrapper provides a parse() that enforces the step schema.
      return req.outputSchema.parse(output);
    },
  };
}

function turn(overrides: Partial<ForgeTurnRow>): ForgeTurnRow {
  return {
    id: "forge_turn_x",
    threadId: "thread_a",
    index: 0,
    source: { kind: "operator", userId: "user_a" },
    audience: "project:member",
    authorKind: "operator",
    render: { body: "hello", attentionItems: [], insights: [], prompts: [] },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function ctx(overrides: Partial<ForgeConversationContext>): ForgeConversationContext {
  return {
    question: "what is blocking my milestones?",
    history: [],
    projectId: null,
    runId: null,
    toolResults: [],
    ...overrides,
  };
}

describe("buildForgePrompt (conversation prompt builder)", () => {
  it("leads with the system preamble and the read-only tool surface", () => {
    const prompt = buildForgePrompt(ctx({}));
    // The preamble appears first and names the platform + the JSON contract.
    expect(prompt.startsWith("You are Forge")).toBe(true);
    expect(prompt).toContain('{"kind":"tools"');
    expect(prompt).toContain('{"kind":"final"');
    // The exact read tools are listed; a write tool is never offered.
    expect(prompt).toContain("- tanren.read_insights");
    expect(prompt).toContain("- repo.read_issue");
    expect(prompt).not.toContain("tanren.create_spec");
    expect(prompt).not.toContain("tanren.trigger_run");
  });

  it("renders an explicit project+run scope line when both are set", () => {
    const prompt = buildForgePrompt(ctx({ projectId: "project_a", runId: "run_7" }));
    expect(prompt).toContain("Thread scope: projectId=project_a runId=run_7");
    expect(prompt).not.toContain("org-wide");
  });

  it("renders project-only scope without a runId fragment", () => {
    const prompt = buildForgePrompt(ctx({ projectId: "project_a", runId: null }));
    expect(prompt).toContain("Thread scope: projectId=project_a");
    expect(prompt).not.toContain("runId=");
  });

  it("renders an org-wide scope line when neither project nor run is set", () => {
    const prompt = buildForgePrompt(ctx({ projectId: null, runId: null }));
    expect(prompt).toContain("Thread scope: org-wide");
    expect(prompt).not.toContain("projectId=");
  });

  it("includes the operator's question verbatim", () => {
    const prompt = buildForgePrompt(ctx({ question: "why did run_42 stall?" }));
    expect(prompt).toContain("Operator question: why did run_42 stall?");
  });

  it("renders prior turns with an operator/forge speaker prefix and the turn body", () => {
    const history: ForgeTurnRow[] = [
      turn({ authorKind: "operator", render: { body: "ship spec_1", attentionItems: [], insights: [], prompts: [] } }),
      turn({
        id: "forge_turn_2",
        index: 1,
        authorKind: "forge_llm",
        render: { body: "I queued a run.", attentionItems: [], insights: [], prompts: [] },
      }),
    ];
    const prompt = buildForgePrompt(ctx({ history }));
    expect(prompt).toContain("Conversation so far:");
    // operator turns are labelled "operator:"; non-operator turns "forge:".
    expect(prompt).toContain("operator: ship spec_1");
    expect(prompt).toContain("forge: I queued a run.");
    // The forge label is NOT applied to the operator turn.
    expect(prompt).not.toContain("forge: ship spec_1");
  });

  it("omits the conversation section entirely when there is no history", () => {
    const prompt = buildForgePrompt(ctx({ history: [] }));
    expect(prompt).not.toContain("Conversation so far:");
  });

  it("falls back to JSON for a turn render that has no string body", () => {
    const weird = turn({ render: { notABody: 5 } as unknown as ForgeTurnRow["render"] });
    const prompt = buildForgePrompt(ctx({ history: [weird] }));
    // Non-string-body render is JSON-stringified, not silently dropped.
    expect(prompt).toContain('{"notABody":5}');
  });

  it("renders a successful read-tool result and prompts the model to decide next", () => {
    const prompt = buildForgePrompt(
      ctx({
        toolResults: [
          { call: { tool: "tanren.read_insights", args: { projectId: "project_a" } }, result: { insights: [] } },
        ],
      }),
    );
    expect(prompt).toContain("Read-tool results gathered this exchange:");
    expect(prompt).toContain("tanren.read_insights");
    expect(prompt).toContain('{"insights":[]}');
    expect(prompt).toContain("Decide: request more read tools, or finalize with a ForgeAnswer.");
  });

  it("renders a failed read-tool result as an ERROR line, not the (absent) payload", () => {
    const prompt = buildForgePrompt(
      ctx({
        toolResults: [{ call: { tool: "tanren.read_run", args: { runId: "run_x" } }, error: "run not found: run_x" }],
      }),
    );
    expect(prompt).toContain("ERROR: run not found: run_x");
  });

  it("uses the no-results decide hint when no tools have run yet", () => {
    const prompt = buildForgePrompt(ctx({ toolResults: [] }));
    expect(prompt).toContain("finalize directly if no data is needed");
    expect(prompt).not.toContain("Read-tool results gathered this exchange:");
  });

  it("the TERMINAL pass tells the model it MUST finalize NOW and stops offering tools (§7.10)", () => {
    const prompt = buildForgePrompt(ctx({ finalize: true }));
    expect(prompt).toContain("FINAL STEP");
    expect(prompt).toContain("MUST return");
    expect(prompt).toContain('{"kind":"final"');
    // The normal "request more tools" decide line is suppressed on the terminal pass.
    expect(prompt).not.toContain("Decide: request more read tools, or finalize");
    expect(prompt).not.toContain("finalize directly if no data is needed");
  });

  it("truncates an over-long tool payload with a truncation marker", () => {
    const big = "x".repeat(5000);
    const prompt = buildForgePrompt(
      ctx({
        toolResults: [{ call: { tool: "repo.read_file", args: { projectId: "project_a", path: "a" } }, result: big }],
      }),
    );
    expect(prompt).toContain("… (truncated)");
    // The full 5000-char payload must NOT be embedded verbatim.
    expect(prompt).not.toContain(big);
  });

  it("does not truncate a payload at exactly the 4000-char budget (boundary)", () => {
    // JSON.stringify wraps a string in quotes, so a 3998-char string serializes
    // to exactly 4000 chars — the inclusive `<= max` boundary keeps it intact.
    const exact = "y".repeat(3998);
    const prompt = buildForgePrompt(
      ctx({
        toolResults: [{ call: { tool: "repo.read_file", args: { projectId: "project_a", path: "a" } }, result: exact }],
      }),
    );
    expect(prompt).not.toContain("… (truncated)");
    expect(prompt).toContain(exact);
  });

  it("renders a string-typed turn body directly (not JSON-wrapped) for an operator turn", () => {
    // A render WITH a string body must take the body-extraction branch, so the
    // raw body text appears and the JSON-stringified object form does NOT.
    const op = turn({
      authorKind: "operator",
      render: { body: "plain body text", attentionItems: [], insights: [], prompts: [] },
    });
    const prompt = buildForgePrompt(ctx({ history: [op] }));
    expect(prompt).toContain("operator: plain body text");
    expect(prompt).not.toContain('"body":"plain body text"');
  });
});

describe("createFakeForgeAnswerer (scripted answerer)", () => {
  it("returns each scripted step in order then repeats the last one", async () => {
    const answerer = createFakeForgeAnswerer({
      script: [
        { kind: "tools", toolCalls: [{ tool: "tanren.read_insights", args: { projectId: "project_a" } }] },
        { kind: "final", answer: { body: "done", attentionItems: [], insights: [], prompts: [] } },
      ],
    });
    const c = ctx({});
    const first = await answerer.respond(c);
    expect(first.kind).toBe("tools");
    const second = await answerer.respond(c);
    expect(second.kind).toBe("final");
    // A third call past the end repeats the LAST step (not the first, not empty).
    const third = await answerer.respond(c);
    expect(third).toEqual(second);
  });

  it("filters a write tool out of a scripted tools step (read-only at the boundary)", async () => {
    const answerer = createFakeForgeAnswerer({
      script: [
        {
          kind: "tools",
          // A scripted step that mixes a write tool in with a read tool.
          toolCalls: [
            { tool: "tanren.create_spec", args: { projectId: "project_a", title: "x", description: "y" } },
            { tool: "tanren.read_insights", args: { projectId: "project_a" } },
          ] as never,
        },
      ],
    });
    const step = asTools(await answerer.respond(ctx({})));
    // Only the read tool survives normalization; the write tool is dropped.
    expect(step.toolCalls.map((t) => t.tool)).toEqual(["tanren.read_insights"]);
  });

  it("passes the context to the onRespond spy and still returns the scripted step", async () => {
    const seen: ForgeConversationContext[] = [];
    const answerer = createFakeForgeAnswerer({
      onRespond: (c) => seen.push(c),
      script: [{ kind: "final", answer: { body: "hi", attentionItems: [], insights: [], prompts: [] } }],
    });
    const passed = ctx({ question: "ping" });
    const step = await answerer.respond(passed);
    // Observable outcome: the spy saw the real context AND the step came back.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.question).toBe("ping");
    expect(step.kind).toBe("final");
  });

  it("synthesizes a no-script fallback final when the script is empty", async () => {
    const answerer = createFakeForgeAnswerer({ script: [] });
    const step = asFinal(await answerer.respond(ctx({})));
    const answer = ForgeAnswer.parse(step.answer);
    expect(answer.body).toContain("no script");
  });
});

describe("wrapProviderAnswerer (provider seam normalization)", () => {
  it("drops write tools from a provider 'tools' step before the engine sees it", async () => {
    const answerer = wrapProviderAnswerer(
      adapterReturning({
        kind: "tools",
        toolCalls: [
          { tool: "tanren.trigger_run", args: { specId: "spec_1" } },
          { tool: "tanren.read_costs", args: {} },
        ],
      }) as never,
    );
    const step = asTools(await answerer.respond(ctx({ projectId: "project_a" })));
    // The mutating tool the model asked for is filtered; only the read remains.
    expect(step.toolCalls.map((t) => t.tool)).toEqual(["tanren.read_costs"]);
  });

  it("passes a final provider step through unchanged", async () => {
    const answerer = wrapProviderAnswerer(
      adapterReturning({
        kind: "final",
        answer: { body: "answer", attentionItems: [], insights: [], prompts: ["next"] },
      }) as never,
    );
    const step = asFinal(await answerer.respond(ctx({})));
    expect(step.answer.body).toBe("answer");
  });
});

describe("ForgeAnswererStepSchema (provider output contract)", () => {
  it("rejects a tools step with an empty toolCalls array", () => {
    expect(ForgeAnswererStepSchema.safeParse({ kind: "tools", toolCalls: [] }).success).toBe(false);
  });

  it("accepts a well-formed final step", () => {
    const parsed = ForgeAnswererStepSchema.safeParse({
      kind: "final",
      answer: { body: "ok", attentionItems: [], insights: [], prompts: [] },
    });
    expect(parsed.success).toBe(true);
  });
});
