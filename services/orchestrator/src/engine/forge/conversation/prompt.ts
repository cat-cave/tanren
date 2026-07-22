// prompt construction for the thick-Forge conversation answerer.
//
// Turns the structured conversation context (operator question + audience-
// filtered thread history + read-tool results) into the single text prompt the
// provider Answerer consumes. The provider returns a strict JSON object that
// validates against the ForgeAnswererStep schema (answerer.ts), so the prompt
// is explicit about the contract: either request more READ tools, or finalize
// with a ForgeAnswer. WRITE tools are out of scope (deferred) and the prompt
// says so, so the model never proposes one.

import type { ForgeTurnRow } from "../schemas.js";
import { FORGE_READ_TOOLS, type ForgeConversationContext } from "./types.js";

const SYSTEM_PREAMBLE = [
  "You are Forge, the operator-facing conversational layer of the tanren platform.",
  "You answer questions about a software-delivery portfolio: specs, runs, costs, milestones, behaviors, and workflow insights.",
  "You ground every answer in data you read through the read-only tool surface — never invent run ids, costs, or PR numbers.",
  "",
  "You operate in a tool loop. On each step you MUST return ONE of:",
  '  - {"kind":"tools","toolCalls":[ ... ]}  to request read-only data, or',
  '  - {"kind":"final","answer":{ ... }}      to finish with a ForgeAnswer.',
  "",
  "Read-only tools you may call (NO write/mutating tools are permitted):",
  ...FORGE_READ_TOOLS.map((tool) => `  - ${tool}`),
  "",
  "The ForgeAnswer shape:",
  "  body            (string)  one or two sentences answering the question; may use <b>/<code> inline html.",
  "  attentionItems  (array)   ranked items; each { priority, title, sub, action }. action may carry a read-tool",
  "                            call (renders as an auto-navigate card) or be null.",
  "  insights        (array)   workflow insights with their own actions.",
  "  prompts         (array)   2-4 short follow-up suggestions the operator might ask next (rendered as chips).",
  "",
  "Keep answers concise and operator-focused. Always include 2-4 follow-up prompts.",
].join("\n");

function renderTurn(turn: ForgeTurnRow): string {
  const who = turn.authorKind === "operator" ? "operator" : "forge";
  const render = turn.render;
  const body =
    typeof render === "object" && render !== null && typeof (render as { body?: unknown }).body === "string"
      ? (render as { body: string }).body
      : JSON.stringify(render);
  return `${who}: ${body}`;
}

export function buildForgePrompt(context: ForgeConversationContext): string {
  const sections: string[] = [SYSTEM_PREAMBLE, ""];

  const scope: string[] = [];
  if (context.projectId !== null) scope.push(`projectId=${context.projectId}`);
  if (context.runId !== null) scope.push(`runId=${context.runId}`);
  sections.push(scope.length > 0 ? `Thread scope: ${scope.join(" ")}` : "Thread scope: org-wide");

  if (context.history.length > 0) {
    sections.push("", "Conversation so far:");
    for (const turn of context.history) {
      sections.push(renderTurn(turn));
    }
  }

  sections.push("", `Operator question: ${context.question}`);

  if (context.toolResults.length > 0) {
    sections.push("", "Read-tool results gathered this exchange:");
    for (const entry of context.toolResults) {
      const payload = entry.error === undefined ? JSON.stringify(entry.result) : `ERROR: ${entry.error}`;
      sections.push(`- ${entry.call.tool}(${JSON.stringify(entry.call.args)}) => ${truncate(payload)}`);
    }
  }

  // TERMINAL pass: the tool-round budget is spent. Tell the
  // model it MUST finalize now — NO further tool requests will run — so it commits to
  // a ForgeAnswer from what it already has instead of burning the last call on tools.
  if (context.finalize === true) {
    sections.push(
      "",
      'FINAL STEP — the tool-round budget is spent. You MUST return {"kind":"final",...}',
      "NOW with your best ForgeAnswer from the data already gathered. Do NOT request any",
      "tools; a tool request here is ignored and you get no further turn.",
    );
  } else if (context.toolResults.length > 0) {
    sections.push("", "Decide: request more read tools, or finalize with a ForgeAnswer.");
  } else {
    sections.push("", "Decide: request read tools to ground your answer, or finalize directly if no data is needed.");
  }

  return sections.join("\n");
}

// Keep individual tool payloads from blowing the prompt budget; the answerer
// only needs enough to reason, not the full event firehose.
function truncate(value: string, max = 4000): string {
  return value.length <= max ? value : `${value.slice(0, max)}… (truncated)`;
}
