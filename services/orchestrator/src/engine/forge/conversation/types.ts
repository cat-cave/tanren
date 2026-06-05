// thick-Forge conversation types.
//
// The conversation engine (engine.ts) reads a thread's prior turns, asks an
// injectable Answerer to reason over them (optionally invoking READ tools from
// the Forge tool surface), and persists the operator + Forge turns.
//
// `ForgeConversationAnswerer` is the seam that makes the LLM call mockable:
// the real implementation wraps a provider Answerer (Claude/Codex);
// tests inject a deterministic fake so no test ever hits a provider. The
// answerer never executes tools itself — it RETURNS the read-tool calls it
// wants, the engine runs them (through the authz'd tool layer), feeds the
// results back, and asks the answerer to finalize. This keeps tool authz +
// redaction inside the existing tool layer rather than the model boundary.

import type { ForgeAnswer, ForgeToolCall } from "../../answerers/schemas/forge.js";
import type { ForgeTurnRow } from "../schemas.js";

// A single read-tool invocation the answerer requested. Only the read family
// is honored by the engine; write tools (create_spec / trigger_run / …) are
// deferred (see engine.ts) — the answerer must not drive them in.
export type ForgeReadToolCall = Extract<
  ForgeToolCall,
  {
    tool:
      | "tanren.read_spec"
      | "tanren.read_run"
      | "tanren.read_events"
      | "tanren.read_costs"
      | "tanren.read_behaviors"
      | "tanren.read_milestones"
      | "tanren.read_insights"
      | "repo.read_file"
      | "repo.grep"
      | "repo.read_issue";
  }
>;

// The read tools whose names the engine will dispatch. Mirrors ForgeReadToolCall
// as a runtime value so the engine can reject a write-tool request defensively.
export const FORGE_READ_TOOLS = [
  "tanren.read_spec",
  "tanren.read_run",
  "tanren.read_events",
  "tanren.read_costs",
  "tanren.read_behaviors",
  "tanren.read_milestones",
  "tanren.read_insights",
  "repo.read_file",
  "repo.grep",
  "repo.read_issue",
] as const;

export function isReadToolName(tool: string): boolean {
  return (FORGE_READ_TOOLS as readonly string[]).includes(tool);
}

// The result of running one read tool, fed back to the answerer on the next
// step. `result` is the raw tool return (already redacted/authz'd by the tool
// layer); `error` is set instead when the tool threw (e.g. access denied) so
// the answerer can reason about the failure rather than the engine aborting.
export interface ForgeToolResult {
  call: ForgeReadToolCall;
  result?: unknown;
  error?: string;
}

// What the answerer returns at each step. Either it asks for more read tools
// (the engine runs them and re-invokes), or it finalizes with a ForgeAnswer.
export type ForgeAnswererStep =
  | { kind: "tools"; toolCalls: ForgeReadToolCall[] }
  | { kind: "final"; answer: ForgeAnswer };

// The thread context handed to the answerer: the prior turns (already audience-
// filtered by the turn store) plus the new operator question.
export interface ForgeConversationContext {
  // The operator's question that opened this exchange.
  question: string;
  // Prior turns in the thread, oldest-first.
  history: ReadonlyArray<ForgeTurnRow>;
  // The project this thread is scoped to (when project/run-scoped), so the
  // answerer can ground itself and address read tools at the right project.
  projectId: string | null;
  runId: string | null;
  // Results of any read tools the engine has run so far in THIS exchange.
  toolResults: ReadonlyArray<ForgeToolResult>;
}

// The injectable answerer. The engine calls `respond` once per step until it
// returns a `final`. The production implementation is `wrapProviderAnswerer`
// (real LLM); tests use a scripted fake fixture. Pure async — no DB, no state.
export interface ForgeConversationAnswerer {
  respond(context: ForgeConversationContext): Promise<ForgeAnswererStep>;
}
