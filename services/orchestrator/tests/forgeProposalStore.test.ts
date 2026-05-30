// Mutation ratchet (test/mutation-ratchet-forge): behavior-based coverage of the
// Forge proposal STORE (proposals.ts) below the end-to-end approve/reject flow.
// The store was at 55% in the cluster baseline: the decodeRow null-coalescing
// (decidedBy / decidedAt / result / error), the parseJsonb string-vs-object
// branch, the recordOutcome executed-vs-failed arms, the claimForDecision
// lost-race path, and listForThread ordering were never pinned.
//
// Every assertion is on a real persisted/decoded row through the in-memory pg
// substitute — no mocks, no spy-call assertions.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ForgeWriteToolCall } from "../src/engine/answerers/schemas/forge.js";
import {
  ForgeProposalStore,
  ProposalAlreadyDecidedError,
  ProposalNotFoundError,
  toolCallForProposal,
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

const TRIGGER_RUN: ForgeWriteToolCall = { tool: "tanren.trigger_run", args: { specId: "spec_1" } };

async function seedThreadAndTurn(client: ForgeMemoryClient): Promise<{ threadId: string; turnId: string }> {
  const thread = await ForgeThreadStore.create(
    client as never,
    { orgId: "org_a", scope: "project", projectId: "project_a", runId: null, title: null },
    operator,
  );
  // A proposal references a proposing turn; seed one so the FK-ish field is real.
  const turn = client.turns;
  client.turns.push({
    id: "forge_turn_seed",
    thread_id: thread.id,
    turn_index: turn.length,
    source: { kind: "operator", userId: "user_op" },
    audience: "project:member",
    author_kind: "forge_llm",
    render: { body: "x", attentionItems: [], insights: [], prompts: [] },
    created_at: client.now,
  });
  return { threadId: thread.id, turnId: "forge_turn_seed" };
}

async function createPending(client: ForgeMemoryClient, threadId: string, turnId: string) {
  return ForgeProposalStore.create(client as never, {
    orgId: "org_a",
    threadId,
    proposingTurnId: turnId,
    toolCall: TRIGGER_RUN,
    rationale: "ship it",
  });
}

describe("ForgeProposalStore.create + decodeRow", () => {
  it("a freshly created proposal decodes its NULL decision fields as null, not a value", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    expect(row.status).toBe("pending");
    // The null-coalescing in decodeRow must yield null for an undecided row —
    // not the raw id, not a Date, not a string.
    expect(row.decidedBy).toBeNull();
    expect(row.decidedAt).toBeNull();
    expect(row.result).toBeNull();
    expect(row.error).toBeNull();
    // The non-null fields round-trip with their real values.
    expect(row.orgId).toBe("org_a");
    expect(row.threadId).toBe(threadId);
    expect(row.proposingTurnId).toBe(turnId);
    expect(row.toolName).toBe("tanren.trigger_run");
    expect(row.args).toEqual({ specId: "spec_1" });
    expect(row.rationale).toBe("ship it");
    expect(row.proposedAt).toBeInstanceOf(Date);
  });

  it("coalesces UNDEFINED decision columns to null (driver-omitted fields)", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    // A driver may hand back `undefined` (not null) for absent columns. The
    // `=== undefined` half of each decode guard must still coalesce to null.
    const stored = client.proposals.find((p) => p.id === row.id)!;
    stored.decided_by = undefined as never;
    stored.decided_at = undefined as never;
    stored.result = undefined as never;
    stored.error = undefined as never;
    const reread = await ForgeProposalStore.get(client as never, row.id, operator);
    expect(reread?.decidedBy).toBeNull();
    expect(reread?.decidedAt).toBeNull();
    expect(reread?.result).toBeNull();
    expect(reread?.error).toBeNull();
  });

  it("preserves a SET decided_by / decided_at / error after a decision (non-null branch)", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    await ForgeProposalStore.claimForDecision(client as never, row.id, "approved", operator);
    const failed = await ForgeProposalStore.recordOutcome(client as never, row.id, {
      status: "failed",
      error: "boom",
    });
    // The non-null arm of each guard returns the real value, not null.
    expect(failed.decidedBy).toBe("user_op");
    expect(failed.decidedAt).toBeInstanceOf(Date);
    expect(failed.error).toBe("boom");
  });

  it("decodes a string-encoded args jsonb back into an object (parseJsonb)", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    // Simulate a driver that hands jsonb back as a STRING rather than an object.
    const stored = client.proposals.find((p) => p.id === row.id)!;
    stored.args = JSON.stringify({ specId: "spec_1" });
    const reread = await ForgeProposalStore.get(client as never, row.id, operator);
    // parseJsonb must JSON.parse the string form into the same object.
    expect(reread?.args).toEqual({ specId: "spec_1" });
  });
});

describe("ForgeProposalStore.claimForDecision", () => {
  it("transitions a pending proposal to the decided status under the deciding actor", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    const claimed = await ForgeProposalStore.claimForDecision(client as never, row.id, "approved", operator);
    expect(claimed.status).toBe("approved");
    expect(claimed.decidedBy).toBe("user_op");
    expect(claimed.decidedAt).toBeInstanceOf(Date);
  });

  it("throws ProposalNotFoundError for an unknown proposal id", async () => {
    const client = new ForgeMemoryClient();
    await seedThreadAndTurn(client);
    const err = await ForgeProposalStore.claimForDecision(
      client as never,
      "forge_proposal_missing",
      "approved",
      operator,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProposalNotFoundError);
    expect((err as Error).message).toContain("forge_proposal_missing");
  });

  it("throws ProposalAlreadyDecidedError carrying the current status on a second claim", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    await ForgeProposalStore.claimForDecision(client as never, row.id, "rejected", operator);
    const err = await ForgeProposalStore.claimForDecision(client as never, row.id, "approved", operator).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProposalAlreadyDecidedError);
    expect((err as ProposalAlreadyDecidedError).currentStatus).toBe("rejected");
    // The message names both the proposal and its current (rejected) status.
    expect((err as Error).message).toContain(row.id);
    expect((err as Error).message).toContain("rejected");
  });
});

describe("ForgeProposalStore.recordOutcome", () => {
  it("executed: persists the result and leaves error null", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    await ForgeProposalStore.claimForDecision(client as never, row.id, "approved", operator);
    const out = await ForgeProposalStore.recordOutcome(client as never, row.id, {
      status: "executed",
      result: { runId: "run_new" },
    });
    expect(out.status).toBe("executed");
    expect(out.result).toEqual({ runId: "run_new" });
    expect(out.error).toBeNull();
  });

  it("failed: persists the error message and leaves result null", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    await ForgeProposalStore.claimForDecision(client as never, row.id, "approved", operator);
    const out = await ForgeProposalStore.recordOutcome(client as never, row.id, {
      status: "failed",
      error: "access denied",
    });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("access denied");
    expect(out.result).toBeNull();
  });

  it("executed with an undefined result persists null (not undefined) for result", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    await ForgeProposalStore.claimForDecision(client as never, row.id, "approved", operator);
    const out = await ForgeProposalStore.recordOutcome(client as never, row.id, {
      status: "executed",
      result: undefined,
    });
    expect(out.status).toBe("executed");
    expect(out.result).toBeNull();
  });
});

describe("ForgeProposalStore.get / listForThread", () => {
  it("get returns undefined for an unknown id without throwing", async () => {
    const client = new ForgeMemoryClient();
    await seedThreadAndTurn(client);
    const got = await ForgeProposalStore.get(client as never, "forge_proposal_nope", operator);
    expect(got).toBeUndefined();
  });

  it("listForThread returns the thread's proposals newest-first", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const first = await createPending(client, threadId, turnId);
    // Advance the clock so the second proposal sorts strictly after the first.
    client.now = new Date(client.now.getTime() + 1000);
    const second = await createPending(client, threadId, turnId);
    const list = await ForgeProposalStore.listForThread(client as never, threadId, operator);
    expect(list.map((p) => p.id)).toEqual([second.id, first.id]);
  });
});

describe("toolCallForProposal (re-validation before execute)", () => {
  it("reconstructs the typed write call from a persisted row", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    const call = toolCallForProposal(row);
    expect(call).toEqual({ tool: "tanren.trigger_run", args: { specId: "spec_1" } });
  });

  it("rejects a persisted row whose tool/args no longer validate", async () => {
    const client = new ForgeMemoryClient();
    const { threadId, turnId } = await seedThreadAndTurn(client);
    const row = await createPending(client, threadId, turnId);
    // Corrupt the persisted tool name so re-validation must fail loudly rather
    // than silently executing an unknown write.
    const corrupted = { ...row, toolName: "tanren.not_a_real_tool" };
    expect(() => toolCallForProposal(corrupted)).toThrow(/invalid|discriminator|tool/iu);
  });
});
