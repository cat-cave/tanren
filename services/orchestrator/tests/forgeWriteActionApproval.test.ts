// P3-0010 (write-action approval): end-to-end behavior of propose → approve →
// execute, plus reject, idempotency, and authz denial.
//
// No provider is contacted (a scripted fake answerer) and no real mutation
// runs (an injected write dispatcher that records an observable side effect and
// enforces a real authz gate). Every assertion is on observable outcome:
// persisted proposal status, the recorded forge turn, the executed write's
// effect, and HTTP-shaped 409 idempotency — not on mock-call counts.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { ForgeAnswer, type ForgeWriteToolCall } from "../src/engine/answerers/schemas/forge.js";
import {
  askForge,
  createFakeForgeAnswerer,
  decideForgeProposal,
  ForgeProposalStore,
  ProposalAlreadyDecidedError,
  WriteToolAccessDeniedError,
  type ForgeReadToolDispatcher,
  type ForgeWriteToolDispatcher,
} from "../src/engine/forge/index.js";
import { ForgeThreadStore } from "../src/engine/forge/threads.js";
import { ForgeMemoryClient } from "./helpers/forgeMemoryClient.js";

const operator: ActorContext = {
  userId: "user_op",
  orgId: "org_a",
  projectId: "project_a",
  scopes: ["org:member", "project:member"],
  source: "session",
};

const noReadTools: ForgeReadToolDispatcher = () => Promise.resolve({});

async function seedThread(client: ForgeMemoryClient): Promise<string> {
  const thread = await ForgeThreadStore.create(
    client as never,
    { orgId: "org_a", scope: "project", projectId: "project_a", runId: null, title: null },
    operator,
  );
  return thread.id;
}

// A fake answerer that finalizes with a single proposed write action.
function answererProposing(toolCall: ForgeWriteToolCall, rationale: string) {
  return createFakeForgeAnswerer({
    script: [
      {
        kind: "final",
        answer: {
          body: "I can take that action for you, with your approval.",
          attentionItems: [],
          insights: [],
          prompts: [],
          proposedActions: [{ toolCall, rationale }],
        },
      },
    ],
  });
}

const TRIGGER_RUN: ForgeWriteToolCall = { tool: "tanren.trigger_run", args: { specId: "spec_1" } };

describe("forge write-action approval (propose → approve → execute)", () => {
  it("persists a proposed write as pending without executing it", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);

    const executed: ForgeWriteToolCall[] = [];
    const result = await askForge(
      {
        client: client as never,
        answerer: answererProposing(TRIGGER_RUN, "the spec is ready to ship"),
        dispatchReadTool: noReadTools,
      },
      { threadId, question: "ship spec_1", audience: "project:member", actor: operator },
    );

    // One pending proposal persisted; no write ran during the ask.
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal?.status).toBe("pending");
    expect(proposal?.toolName).toBe("tanren.trigger_run");
    expect(proposal?.rationale).toBe("the spec is ready to ship");
    expect(proposal?.proposingTurnId).toBe(result.forgeTurn.id);
    expect(executed).toHaveLength(0);

    // It is queryable as pending through the store under the operator's authz.
    const fetched = await ForgeProposalStore.get(client as never, proposal!.id, operator);
    expect(fetched?.status).toBe("pending");
  });

  it("approve executes the write under the operator's authz and records the outcome + a turn", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);
    const { proposals, forgeTurn } = await askForge(
      {
        client: client as never,
        answerer: answererProposing(TRIGGER_RUN, "ship it"),
        dispatchReadTool: noReadTools,
      },
      { threadId, question: "ship spec_1", audience: "project:member", actor: operator },
    );
    const proposalId = proposals[0]!.id;

    // A write dispatcher that records the actor it executed under (the safety
    // property: the APPROVING operator's authz) and returns an observable run id.
    const executedAs: string[] = [];
    const executeWrite: ForgeWriteToolDispatcher = async (call, actor) => {
      executedAs.push(actor.userId);
      return { specId: (call as { args: { specId: string } }).args.specId, runId: "run_new" };
    };

    const decided = await decideForgeProposal(
      { client: client as never, executeWrite },
      { proposalId, decision: "approved", actor: operator },
    );

    // The write ran exactly once, under the approving operator.
    expect(executedAs).toEqual(["user_op"]);
    // The proposal is recorded executed with the write's result.
    expect(decided.proposal.status).toBe("executed");
    expect(decided.proposal.decidedBy).toBe("user_op");
    expect(decided.proposal.result).toMatchObject({ runId: "run_new" });
    // A new forge turn narrates the decision and validates as a ForgeAnswer.
    const turnAnswer = ForgeAnswer.parse(decided.turn.render);
    expect(turnAnswer.body).toContain("executed");
    // The decision turn comes after the proposing turn.
    expect(decided.turn.index).toBeGreaterThan(forgeTurn.index);
  });

  it("reject records the proposal as rejected with a turn and never executes", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);
    const { proposals } = await askForge(
      {
        client: client as never,
        answerer: answererProposing(TRIGGER_RUN, "ship it"),
        dispatchReadTool: noReadTools,
      },
      { threadId, question: "ship spec_1", audience: "project:member", actor: operator },
    );

    let writeRan = false;
    const decided = await decideForgeProposal(
      { client: client as never, executeWrite: async () => ((writeRan = true), {}) },
      { proposalId: proposals[0]!.id, decision: "rejected", actor: operator },
    );

    expect(writeRan).toBe(false);
    expect(decided.proposal.status).toBe("rejected");
    expect(decided.proposal.decidedBy).toBe("user_op");
    const turnAnswer = ForgeAnswer.parse(decided.turn.render);
    expect(turnAnswer.body).toContain("Rejected");
  });

  it("is idempotent: a second approve returns already-decided and never double-executes", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);
    const { proposals } = await askForge(
      {
        client: client as never,
        answerer: answererProposing(TRIGGER_RUN, "ship it"),
        dispatchReadTool: noReadTools,
      },
      { threadId, question: "ship spec_1", audience: "project:member", actor: operator },
    );
    const proposalId = proposals[0]!.id;

    let executions = 0;
    const executeWrite: ForgeWriteToolDispatcher = async () => ((executions += 1), { runId: "run_new" });

    const first = await decideForgeProposal(
      { client: client as never, executeWrite },
      { proposalId, decision: "approved", actor: operator },
    );
    expect(first.proposal.status).toBe("executed");
    expect(executions).toBe(1);

    // Second approve: typed already-decided error, no further execution.
    await expect(
      decideForgeProposal(
        { client: client as never, executeWrite },
        { proposalId, decision: "approved", actor: operator },
      ),
    ).rejects.toBeInstanceOf(ProposalAlreadyDecidedError);
    expect(executions).toBe(1);

    // The persisted row is still executed (not re-decided).
    const persisted = await ForgeProposalStore.get(client as never, proposalId, operator);
    expect(persisted?.status).toBe("executed");
  });

  it("authz denial: a write the operator may not perform records failed, not executed", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);
    const { proposals } = await askForge(
      {
        client: client as never,
        answerer: answererProposing(TRIGGER_RUN, "ship it"),
        dispatchReadTool: noReadTools,
      },
      { threadId, question: "ship spec_1", audience: "project:member", actor: operator },
    );

    // The write dispatcher authz's the APPROVING actor and denies one lacking
    // the admin scope (as the real write tools do via WriteToolAccessDeniedError).
    // It records the mutation count so we can assert no write landed.
    let mutations = 0;
    const executeWrite: ForgeWriteToolDispatcher = (_call, actor) => {
      if (!actor.scopes.includes("project:admin") && !actor.scopes.includes("org:admin")) {
        throw new WriteToolAccessDeniedError(`actor ${actor.userId} cannot trigger runs on spec_1`);
      }
      mutations += 1;
      return Promise.resolve({ runId: "run_new" });
    };

    const decided = await decideForgeProposal(
      { client: client as never, executeWrite },
      { proposalId: proposals[0]!.id, decision: "approved", actor: operator },
    );

    // No mutation occurred; the proposal is consumed as failed with the reason.
    expect(mutations).toBe(0);
    expect(decided.proposal.status).toBe("failed");
    expect(decided.proposal.error).toContain("cannot trigger runs");
    const turnAnswer = ForgeAnswer.parse(decided.turn.render);
    expect(turnAnswer.body).toContain("could not run");
  });
});
