// write-action approval: decide a pending Forge action proposal.
//
// The safety property: the model proposed the write, but it executes ONLY when
// a human approves it, and ONLY under the APPROVING operator's ActorContext.
// `decideForgeProposal` is the single chokepoint for both decisions:
//
//   approve → claim the proposal (idempotent), re-validate its args into a
//     typed ForgeWriteToolCall, execute the underlying write through the
//     injected dispatcher (which authz's the operator's ActorContext exactly
//     like the routes), record `executed`/`failed`, and append a forge
//     turn narrating the outcome.
//   reject  → claim the proposal as `rejected` and append a turn recording it.
//
// Idempotency lives in the store's `claimForDecision` (a conditional UPDATE on
// status='pending'); a second decide on an already-decided proposal throws
// `ProposalAlreadyDecidedError`, which the route maps to a 409 — so a write is
// never executed twice. Authz denial from the write dispatcher surfaces as a
// `failed` outcome with the denial message (the proposal is consumed but no
// mutation occurred).

import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { ForgeAnswer, ForgeWriteToolCall } from "../answerers/schemas/forge.js";
import { ForgeProposalStore, type ForgeActionProposalRow, toolCallForProposal } from "./proposals.js";
import { ForgeTurnStore } from "./turns.js";
import type { ForgeTurnAudience, ForgeTurnRow } from "./schemas.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// Executes a single approved WRITE under the operator's authz. Injected so the
// engine has no hard dependency on the route's tool wiring; the route passes a
// dispatcher closed over the pool, tests pass a deterministic stub. The
// dispatcher MUST authz the actor (the write tools already do — see
// `engine/forge/tools/write.ts`) and may throw a `WriteToolAccessDeniedError`.
export type ForgeWriteToolDispatcher = (call: ForgeWriteToolCall, actor: ActorContext) => Promise<unknown>;

export interface ForgeProposalDecisionDeps {
  client: QueryClient;
  executeWrite: ForgeWriteToolDispatcher;
  // The audience the outcome turn is appended at. Defaults to project:member so
  // every reader who can see the thread sees the decision.
  audience?: ForgeTurnAudience;
}

export interface ForgeProposalDecisionResult {
  proposal: ForgeActionProposalRow;
  turn: ForgeTurnRow;
}

export async function decideForgeProposal(
  deps: ForgeProposalDecisionDeps,
  input: { proposalId: string; decision: "approved" | "rejected"; actor: ActorContext },
): Promise<ForgeProposalDecisionResult> {
  // Claim the proposal idempotently. Throws ProposalNotFoundError /
  // ProposalAlreadyDecidedError, which the route maps to 404 / 409.
  const claimed = await ForgeProposalStore.claimForDecision(deps.client, input.proposalId, input.decision, input.actor);
  const audience = deps.audience ?? "project:member";

  if (input.decision === "rejected") {
    const turn = await appendDecisionTurn(deps.client, claimed, audience, input.actor, rejectedAnswer(claimed));
    return { proposal: claimed, turn };
  }

  // Approved: re-validate the persisted args into a typed write call, then
  // execute it under the approving operator's authz.
  const call = toolCallForProposal(claimed);
  let outcome: ForgeActionProposalRow;
  let answer: ForgeAnswer;
  try {
    const result = await deps.executeWrite(call, input.actor);
    outcome = await ForgeProposalStore.recordOutcome(deps.client, claimed.id, { status: "executed", result });
    answer = executedAnswer(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = await ForgeProposalStore.recordOutcome(deps.client, claimed.id, { status: "failed", error: message });
    answer = failedAnswer(outcome, message);
  }
  const turn = await appendDecisionTurn(deps.client, outcome, audience, input.actor, answer);
  return { proposal: outcome, turn };
}

async function appendDecisionTurn(
  client: QueryClient,
  proposal: ForgeActionProposalRow,
  audience: ForgeTurnAudience,
  actor: ActorContext,
  render: ForgeAnswer,
): Promise<ForgeTurnRow> {
  return ForgeTurnStore.append(
    client,
    {
      threadId: proposal.threadId,
      source: { kind: "operator", userId: actor.userId },
      audience,
      authorKind: "operator",
      render,
    },
    actor,
  );
}

function rejectedAnswer(proposal: ForgeActionProposalRow): ForgeAnswer {
  return baseAnswer(`Rejected the proposed \`${proposal.toolName}\` action.`);
}

function executedAnswer(proposal: ForgeActionProposalRow): ForgeAnswer {
  return baseAnswer(`Approved and executed the proposed \`${proposal.toolName}\` action.`);
}

function failedAnswer(proposal: ForgeActionProposalRow, message: string): ForgeAnswer {
  return baseAnswer(`The approved \`${proposal.toolName}\` action could not run: ${message}`);
}

function baseAnswer(body: string): ForgeAnswer {
  return { body, attentionItems: [], insights: [], prompts: [], proposedActions: [] };
}
