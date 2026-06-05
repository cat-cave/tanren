// thick-Forge conversation engine.
//
// Orchestrates one operator→Forge exchange against a persisted thread:
//   1. Append the operator's question as a turn (authorKind "operator").
//   2. Load the thread history (audience-filtered by the turn store).
//   3. Run the answerer loop: ask the injectable answerer for a step; if it
//      requests READ tools, dispatch them through the authz'd tool layer and
//      feed results back; repeat until the answerer finalizes (bounded by
//      maxToolRounds so a misbehaving answerer can't loop forever).
//   4. Append the finalized ForgeAnswer as a turn (authorKind "forge_llm").
//
// WRITE actions follow the propose→approve→execute pattern (write-
// action approval): the answerer is still constrained to the READ family for
// tool DISPATCH (a write-tool request mid-loop is dropped, never executed), but
// its final answer may carry `proposedActions` — write tools it wants a human
// to approve. The engine persists each as a `pending` forge_action_proposals
// row and never executes it; an operator approves it through the approve route,
// which runs the write under the approving operator's authz.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import type { ForgeAnswer } from "../../answerers/schemas/forge.js";
import { ForgeProposalStore, type ForgeActionProposalRow } from "../proposals.js";
import { ForgeThreadStore } from "../threads.js";
import { ForgeTurnStore } from "../turns.js";
import type { ForgeTurnAudience, ForgeTurnRow } from "../schemas.js";
import { isReadToolName } from "./types.js";
import type {
  ForgeConversationAnswerer,
  ForgeConversationContext,
  ForgeReadToolCall,
  ForgeToolResult,
} from "./types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// Dispatches a single READ tool. Injected so the engine has no hard dependency
// on the HTTP route's tool wiring (pool/secrets/githubHttp) — the route passes
// a dispatcher closed over those deps; tests pass a deterministic stub.
export type ForgeReadToolDispatcher = (call: ForgeReadToolCall, actor: ActorContext) => Promise<unknown>;

export interface ForgeConversationDeps {
  client: QueryClient;
  answerer: ForgeConversationAnswerer;
  dispatchReadTool: ForgeReadToolDispatcher;
  // Defaults to 3: enough for a read → reason → finalize loop without letting
  // a runaway answerer spin. Each round may request multiple tools.
  maxToolRounds?: number;
}

export interface ForgeAskInput {
  threadId: string;
  question: string;
  audience: ForgeTurnAudience;
  actor: ActorContext;
}

export interface ForgeAskResult {
  operatorTurn: ForgeTurnRow;
  forgeTurn: ForgeTurnRow;
  // The read tools that actually ran this exchange (for observability/tests).
  toolResults: ReadonlyArray<ForgeToolResult>;
  // Pending write proposals persisted from the answer's `proposedActions`. The
  // engine never executes these — a human approves them via the approve route.
  proposals: ReadonlyArray<ForgeActionProposalRow>;
}

const DEFAULT_MAX_TOOL_ROUNDS = 3;

// Runs one operator question through the conversation engine and persists both
// turns. Throws when the thread is missing or the actor cannot reach it (the
// turn store enforces this on append).
export async function askForge(deps: ForgeConversationDeps, input: ForgeAskInput): Promise<ForgeAskResult> {
  const thread = await ForgeThreadStore.get(deps.client, input.threadId, input.actor);
  if (thread === undefined) {
    throw new Error(`forge thread not found: ${input.threadId}`);
  }

  // Persist the operator's question as a turn so the thread is a faithful
  // transcript. The render is a minimal ForgeAnswer carrying just the body.
  const operatorTurn = await ForgeTurnStore.append(
    deps.client,
    {
      threadId: input.threadId,
      source: { kind: "operator", userId: input.actor.userId },
      audience: input.audience,
      authorKind: "operator",
      render: { body: input.question, attentionItems: [], insights: [], prompts: [] },
    },
    input.actor,
  );

  const history = await ForgeTurnStore.list(deps.client, { threadId: input.threadId, limit: 50 }, input.actor);

  const answer = await runAnswererLoop(deps, {
    question: input.question,
    history,
    projectId: thread.projectId,
    runId: thread.runId,
    actor: input.actor,
  });

  const forgeTurn = await ForgeTurnStore.append(
    deps.client,
    {
      threadId: input.threadId,
      source: { kind: "operator", userId: input.actor.userId },
      audience: input.audience,
      authorKind: "forge_llm",
      render: answer.answer,
    },
    input.actor,
  );

  // Capture any write actions the answer proposed as PENDING proposals. The
  // engine never executes them — a human approves them through the approve
  // route under their own authz. We persist after the forge turn so each
  // proposal references the turn that proposed it.
  const proposals: ForgeActionProposalRow[] = [];
  for (const proposed of answer.answer.proposedActions ?? []) {
    proposals.push(
      await ForgeProposalStore.create(deps.client, {
        orgId: thread.orgId,
        threadId: input.threadId,
        proposingTurnId: forgeTurn.id,
        toolCall: proposed.toolCall,
        rationale: proposed.rationale,
      }),
    );
  }

  return { operatorTurn, forgeTurn, toolResults: answer.toolResults, proposals };
}

interface AnswererLoopInput {
  question: string;
  history: ReadonlyArray<ForgeTurnRow>;
  projectId: string | null;
  runId: string | null;
  actor: ActorContext;
}

interface AnswererLoopResult {
  answer: ForgeAnswer;
  toolResults: ForgeToolResult[];
}

// Drives the answerer until it finalizes or the round budget is spent. When the
// budget is exhausted without a final, the loop asks one last time with a
// `finalize` hint encoded as an empty tool round (the answerer sees no new
// results and is expected to commit to an answer).
async function runAnswererLoop(deps: ForgeConversationDeps, input: AnswererLoopInput): Promise<AnswererLoopResult> {
  const maxRounds = deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const toolResults: ForgeToolResult[] = [];

  for (let round = 0; round <= maxRounds; round += 1) {
    const context: ForgeConversationContext = {
      question: input.question,
      history: input.history,
      projectId: input.projectId,
      runId: input.runId,
      toolResults,
    };
    const step = await deps.answerer.respond(context);
    if (step.kind === "final") {
      return { answer: step.answer, toolResults };
    }
    // On the last round we no longer honor tool requests — force a final next
    // iteration by running zero tools (the loop's terminal pass below).
    if (round === maxRounds) {
      break;
    }
    const requested = step.toolCalls.filter((call) => isReadToolName(call.tool));
    if (requested.length === 0) {
      // Answerer asked for no (valid) read tools but did not finalize — treat
      // the next pass as terminal so we don't spin on an empty request.
      continue;
    }
    for (const call of requested) {
      toolResults.push(await runTool(deps, call, input.actor));
    }
  }

  // Round budget spent without a final: ask once more; the answerer must commit.
  const finalStep = await deps.answerer.respond({
    question: input.question,
    history: input.history,
    projectId: input.projectId,
    runId: input.runId,
    toolResults,
  });
  if (finalStep.kind === "final") {
    return { answer: finalStep.answer, toolResults };
  }
  // Still no final — synthesize a minimal answer rather than throw so the
  // operator always gets a turn back.
  return {
    answer: {
      body: "I could not complete that just now — try rephrasing or narrowing the question.",
      attentionItems: [],
      insights: [],
      prompts: [],
    },
    toolResults,
  };
}

async function runTool(
  deps: ForgeConversationDeps,
  call: ForgeReadToolCall,
  actor: ActorContext,
): Promise<ForgeToolResult> {
  try {
    const result = await deps.dispatchReadTool(call, actor);
    return { call, result };
  } catch (error) {
    return { call, error: error instanceof Error ? error.message : String(error) };
  }
}
