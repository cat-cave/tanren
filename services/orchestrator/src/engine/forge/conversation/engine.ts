// thick-Forge conversation engine.
//
// Orchestrates one operator→Forge exchange against a persisted thread:
//   1. Append the operator's question as a turn (authorKind "operator").
//   2. Load the thread history (audience-filtered by the turn store).
//   3. Run the answerer loop: ask the injectable answerer for a step; if it
//      requests NEW READ tools, dispatch them through the authz'd tool layer and
//      feed results back; repeat until the answerer finalizes OR stops requesting
//      NEW tools (the progress-based exit — a misbehaving answerer that keeps
//      asking for tools it has already run makes no progress and is finalized).
//   4. Append the finalized ForgeAnswer as a turn (authorKind "forge_llm").
//
// TIMEOUT-ERADICATION (feedback_no_timeouts_progress_based, BINDING): there is NO
// fixed `maxToolRounds` count. The loop continues UNBOUNDED while the answerer makes
// PROGRESS — each round requesting a NEW read tool (a `(tool, args)` identity it has
// not already run this exchange). The moment it stops requesting new tools (it
// finalizes, requests none, or requests only tools it already ran — a fixed point),
// the engine runs ONE terminal `finalize` pass and commits the answer. A runaway
// answerer cannot loop forever: re-requesting the same tools is not progress.
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

// Drives the answerer UNBOUNDED while it makes PROGRESS — each round requesting a
// NEW read tool (a `(tool, args)` identity it has not already run this exchange).
// The loop ends the moment the answerer stops making progress: it finalizes, or it
// requests no NEW read tool (none valid, or only tools already dispatched — a fixed
// point). At that point the engine runs ONE terminal `finalize` pass (the §7.10 hint
// telling the model it MUST commit now, no more tools) and commits the answer. There
// is NO round count: a runaway answerer cannot spin, because re-requesting the same
// tools is not progress and ends the loop.
async function runAnswererLoop(deps: ForgeConversationDeps, input: AnswererLoopInput): Promise<AnswererLoopResult> {
  const toolResults: ForgeToolResult[] = [];
  // The `(tool, args)` identities already dispatched this exchange — the progress
  // signal: a request for an identity NOT in here is forward motion; a request for
  // only identities already here (or no valid request) is a fixed point.
  const dispatched = new Set<string>();

  for (;;) {
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
    // Only NEW read tools are progress — drop write tools (never honored) and any
    // read tool whose identity was already dispatched (re-asking is not progress).
    const fresh = step.toolCalls.filter((call) => isReadToolName(call.tool) && !dispatched.has(toolIdentity(call)));
    if (fresh.length === 0) {
      // No progress (no new read tool requested) and no final — stop looping and
      // run the terminal finalize pass below. A misbehaving answerer that keeps
      // re-asking the same tools lands here on its second identical request.
      break;
    }
    for (const call of fresh) {
      dispatched.add(toolIdentity(call));
      toolResults.push(await runTool(deps, call, input.actor));
    }
  }

  // Progress stopped without a final: ask once more with the TERMINAL `finalize`
  // hint (§7.10) so the prompt tells the model it MUST commit now + stops offering
  // tools — no more burning a call on a tool request it can't run.
  const finalStep = await deps.answerer.respond({
    question: input.question,
    history: input.history,
    projectId: input.projectId,
    runId: input.runId,
    toolResults,
    finalize: true,
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

// The stable identity of a read-tool call (`tool` + canonicalized args) — the
// dedup key the progress signal keys off. Two calls with the same tool + same args
// are the SAME request (re-asking it is not progress); different args are distinct.
function toolIdentity(call: ForgeReadToolCall): string {
  return `${call.tool}:${stableStringify(call.args)}`;
}

// Deterministic JSON stringify (object keys sorted) so arg ordering does not make
// two equivalent requests look distinct.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
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
