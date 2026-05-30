// P3-0010: thick-Forge conversation engine tests.
//
// Exercises the LLM-backed conversation backend with a MOCKED answerer (no
// provider is ever contacted): the engine reads prior turns, invokes a READ
// tool the answerer requested, feeds the result back, and persists a final
// ForgeAnswer carrying follow-up prompts. Also asserts write-tool requests are
// dropped (deferred) and the round budget terminates a non-finalizing answerer.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { ForgeAnswer } from "../src/engine/answerers/schemas/forge.js";
import {
  askForge,
  createFakeForgeAnswerer,
  type ForgeConversationAnswerer,
  type ForgeConversationContext,
  type ForgeReadToolCall,
  type ForgeReadToolDispatcher,
} from "../src/engine/forge/index.js";
import { ForgeThreadStore } from "../src/engine/forge/threads.js";
import { createDeterministicForgeAnswerer } from "../src/routes/forge/deterministicAnswerer.js";
import { ForgeMemoryClient } from "./helpers/forgeMemoryClient.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: "project_a",
  scopes: ["org:member", "project:member"],
  source: "session",
};

async function seedProjectThread(client: ForgeMemoryClient): Promise<string> {
  const thread = await ForgeThreadStore.create(
    client as never,
    { orgId: "org_a", scope: "project", projectId: "project_a", runId: null, title: null },
    actor,
  );
  return thread.id;
}

describe("askForge (thick-Forge conversation engine)", () => {
  it("reads a tool the answerer requests, feeds the result back, and finalizes", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedProjectThread(client);

    const seenContexts: ForgeConversationContext[] = [];
    const answerer = createFakeForgeAnswerer({
      onRespond: (ctx) => seenContexts.push(ctx),
      script: [
        {
          kind: "tools",
          toolCalls: [{ tool: "tanren.read_insights", args: { projectId: "project_a" } }],
        },
        {
          kind: "final",
          answer: {
            body: "Two specs are stuck behind a budget call.",
            attentionItems: [],
            insights: [],
            prompts: ["raise the budget", "show the dependency chain"],
          },
        },
      ],
    });

    const dispatched: ForgeReadToolCall[] = [];
    const dispatchReadTool: ForgeReadToolDispatcher = async (call) => {
      dispatched.push(call);
      return { insights: [{ id: "insight_1", kind: "stuck" }] };
    };

    const result = await askForge(
      { client: client as never, answerer, dispatchReadTool },
      { threadId, question: "what's blocking my milestones?", audience: "project:member", actor },
    );

    // The read tool ran exactly once with the requested args.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.tool).toBe("tanren.read_insights");

    // The answerer saw the tool result on its finalizing pass.
    const finalCtx = seenContexts[1];
    expect(finalCtx?.toolResults).toHaveLength(1);
    expect(finalCtx?.toolResults[0]?.call.tool).toBe("tanren.read_insights");

    // Both turns persisted: operator question + forge answer.
    expect(result.operatorTurn.authorKind).toBe("operator");
    expect(result.operatorTurn.render).toMatchObject({ body: "what's blocking my milestones?" });
    expect(result.forgeTurn.authorKind).toBe("forge_llm");

    // The forge turn render validates as a ForgeAnswer and carries follow-ups.
    const answer = ForgeAnswer.parse(result.forgeTurn.render);
    expect(answer.body).toContain("budget");
    expect(answer.prompts).toContain("raise the budget");
    expect(result.toolResults.map((entry) => entry.call.tool)).toContain("tanren.read_insights");
  });

  it("drops write-tool requests (deferred) — never dispatches a mutation", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedProjectThread(client);

    const answerer = createFakeForgeAnswerer({
      script: [
        // A misbehaving answerer asks for a WRITE tool; the engine must ignore it.
        {
          kind: "tools",
          toolCalls: [
            {
              tool: "tanren.create_spec",
              args: { projectId: "project_a", title: "x", description: "y" },
            },
          ],
        },
        {
          kind: "final",
          answer: {
            body: "Here's what I found.",
            attentionItems: [],
            insights: [],
            prompts: ["next?"],
          },
        },
      ],
    });

    const calls: string[] = [];
    const dispatch: ForgeReadToolDispatcher = (call) => {
      calls.push(call.tool);
      return Promise.resolve({});
    };
    await askForge(
      { client: client as never, answerer, dispatchReadTool: dispatch },
      { threadId, question: "draft a spec", audience: "project:member", actor },
    );

    // The write tool was filtered out before any dispatch.
    expect(calls).toHaveLength(0);
  });

  it("terminates with a fallback answer when the answerer never finalizes", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedProjectThread(client);

    // Always asks for the same read tool, never finalizes.
    const answerer = createFakeForgeAnswerer({
      script: [
        {
          kind: "tools",
          toolCalls: [{ tool: "tanren.read_insights", args: { projectId: "project_a" } }],
        },
      ],
    });
    const result = await askForge(
      {
        client: client as never,
        answerer,
        dispatchReadTool: (): Promise<unknown> => Promise.resolve({ insights: [] }),
        maxToolRounds: 2,
      },
      { threadId, question: "loop forever", audience: "project:member", actor },
    );

    const answer = ForgeAnswer.parse(result.forgeTurn.render);
    expect(answer.body.length).toBeGreaterThan(0);
  });

  it("default deterministic answerer grounds a project question via a read tool", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedProjectThread(client);

    const dispatched: ForgeReadToolCall[] = [];
    const dispatchReadTool: ForgeReadToolDispatcher = async (call) => {
      dispatched.push(call);
      return { insights: [] };
    };

    const result = await askForge(
      { client: client as never, answerer: createDeterministicForgeAnswerer(), dispatchReadTool },
      {
        threadId,
        question: "any open insights I should clear?",
        audience: "project:member",
        actor,
      },
    );

    // It read a grounding tool and returned a parseable answer with follow-ups.
    expect(dispatched.some((call) => call.tool === "tanren.read_insights")).toBe(true);
    const answer = ForgeAnswer.parse(result.forgeTurn.render);
    expect(answer.prompts.length).toBeGreaterThan(0);
  });

  // --- mutation ratchet (test/mutation-ratchet-forge): engine edge behaviors ---

  it("throws a not-found error (never persists a turn) when the thread is missing", async () => {
    const client = new ForgeMemoryClient();
    const answerer = createFakeForgeAnswerer({
      script: [{ kind: "final", answer: { body: "x", attentionItems: [], insights: [], prompts: [] } }],
    });
    await expect(
      askForge(
        { client: client as never, answerer, dispatchReadTool: () => Promise.resolve({}) },
        { threadId: "thread_missing", question: "hi", audience: "project:member", actor },
      ),
    ).rejects.toThrowError(/forge thread not found: thread_missing/u);
    // No turns were appended for the nonexistent thread.
    expect(client.turns).toHaveLength(0);
  });

  it("captures a throwing read tool as an error result (not a thrown ask) fed back to the answerer", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedProjectThread(client);

    const seen: ForgeConversationContext[] = [];
    const answerer = createFakeForgeAnswerer({
      onRespond: (ctx) => seen.push(ctx),
      script: [
        { kind: "tools", toolCalls: [{ tool: "tanren.read_run", args: { runId: "run_x" } }] },
        { kind: "final", answer: { body: "handled the failure", attentionItems: [], insights: [], prompts: [] } },
      ],
    });

    const result = await askForge(
      {
        client: client as never,
        answerer,
        dispatchReadTool: () => Promise.reject(new Error("run not found: run_x")),
      },
      { threadId, question: "why did run_x fail?", audience: "project:member", actor },
    );

    // The ask did NOT throw; the tool failure became a ForgeToolResult.error.
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.error).toBe("run not found: run_x");
    expect(result.toolResults[0]?.result).toBeUndefined();
    // The answerer's finalizing pass saw the error result.
    expect(seen[1]?.toolResults[0]?.error).toBe("run not found: run_x");
  });

  it("with maxToolRounds=0 the answerer's first step is its only honored chance to finalize", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedProjectThread(client);

    const dispatched: string[] = [];
    // First step requests a tool; with a 0-round budget no tool may be dispatched
    // (round===maxRounds breaks immediately), then one terminal respond finalizes.
    const answerer = createFakeForgeAnswerer({
      script: [
        { kind: "tools", toolCalls: [{ tool: "tanren.read_insights", args: { projectId: "project_a" } }] },
        { kind: "final", answer: { body: "committed", attentionItems: [], insights: [], prompts: [] } },
      ],
    });

    const result = await askForge(
      {
        client: client as never,
        answerer,
        dispatchReadTool: (call) => {
          dispatched.push(call.tool);
          return Promise.resolve({});
        },
        maxToolRounds: 0,
      },
      { threadId, question: "no budget", audience: "project:member", actor },
    );

    // No read tool ran (budget was zero); the terminal respond produced the answer.
    expect(dispatched).toHaveLength(0);
    const answer = ForgeAnswer.parse(result.forgeTurn.render);
    expect(answer.body).toBe("committed");
  });

  it("continues past an empty (no valid read tools) request and still finalizes", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedProjectThread(client);

    const dispatched: string[] = [];
    const answerer = createFakeForgeAnswerer({
      script: [
        // A write-only tools step normalizes to zero read tools -> the loop must
        // `continue` to the terminal pass rather than dispatch or spin.
        {
          kind: "tools",
          toolCalls: [
            { tool: "tanren.create_spec", args: { projectId: "project_a", title: "x", description: "y" } },
          ] as never,
        },
        { kind: "final", answer: { body: "moved on", attentionItems: [], insights: [], prompts: [] } },
      ],
    });

    const result = await askForge(
      {
        client: client as never,
        answerer,
        dispatchReadTool: (call) => {
          dispatched.push(call.tool);
          return Promise.resolve({});
        },
        maxToolRounds: 3,
      },
      { threadId, question: "empty request", audience: "project:member", actor },
    );

    expect(dispatched).toHaveLength(0);
    const answer = ForgeAnswer.parse(result.forgeTurn.render);
    expect(answer.body).toBe("moved on");
  });

  it("honors a final returned on the terminal post-budget respond (not the fallback)", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedProjectThread(client);

    // Requests a read tool on every budgeted round, then finalizes on the extra
    // terminal respond the loop makes after the budget is spent. The returned
    // answer must be this one, NOT the synthesized "could not complete" fallback.
    let calls = 0;
    const answerer: ForgeConversationAnswerer = {
      respond: () => {
        calls += 1;
        // maxToolRounds=1 -> rounds 0,1 are budgeted; the loop then makes ONE
        // terminal respond. Finalize only on that terminal (3rd) call.
        if (calls >= 3) {
          return Promise.resolve({
            kind: "final",
            answer: { body: "committed at the buzzer", attentionItems: [], insights: [], prompts: [] },
          });
        }
        return Promise.resolve({
          kind: "tools",
          toolCalls: [{ tool: "tanren.read_insights", args: { projectId: "project_a" } }],
        });
      },
    };

    const result = await askForge(
      {
        client: client as never,
        answerer,
        dispatchReadTool: () => Promise.resolve({ insights: [] }),
        maxToolRounds: 1,
      },
      { threadId, question: "buzzer beater", audience: "project:member", actor },
    );

    const answer = ForgeAnswer.parse(result.forgeTurn.render);
    expect(answer.body).toBe("committed at the buzzer");
    expect(answer.body).not.toContain("could not complete");
  });
});
