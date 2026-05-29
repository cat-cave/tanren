/**
 * P3-0010 thick-Forge chat island helper — the chat-mode half of the ⌘K
 * palette, split out of `palette.ts` to keep both under the 500-line cap.
 *
 * Owns the chat thread DOM: appends user + forge turns, renders the answer
 * bubble, follow-up chips, and auto-navigate action cards from a ForgeAnswer,
 * and POSTs questions to the dashboard's `/forge/ask` proxy (which forwards the
 * cookie to the orchestrator's LLM-backed conversation endpoint).
 *
 * Action cards: a card whose toolCall is a READ tool maps to an in-shell route
 * and navigates on click (auto-navigate). A card whose toolCall is a WRITE tool
 * (create_spec / trigger_run / rerun_task / acknowledge_insight) renders but is
 * INERT — write-action approval is deferred.
 *   // TODO: Forge write-action approval (deferred — design pending)
 */

interface ForgeAction {
  label: string;
  toolCall: { tool: string; args?: Record<string, unknown> };
}

interface ForgeAttentionItem {
  priority: string;
  title: string;
  sub: string;
  action?: ForgeAction;
}

interface ForgeAnswer {
  body: string;
  attentionItems: ForgeAttentionItem[];
  insights?: Array<{ kind: string; title: string; body: string; actions: ForgeAction[] }>;
  prompts: string[];
}

interface ForgeAskResponse {
  threadId: string;
  answer: ForgeAnswer;
  toolsUsed: string[];
}

const READ_TOOLS = new Set([
  "tanren.read_spec",
  "tanren.read_run",
  "tanren.read_events",
  "tanren.read_costs",
  "tanren.read_behaviors",
  "tanren.read_milestones",
  "tanren.read_insights",
  "repo.read_file",
  "repo.grep",
  "repo.read_issue"
]);

// Maps a READ-tool action to an in-shell route so an action card can auto-
// navigate. Write tools return undefined (inert card). Mirrors the routes the
// shell exposes for runs/specs/costs.
export function routeForAction(action: ForgeAction): string | undefined {
  const { tool, args = {} } = action.toolCall;
  if (!READ_TOOLS.has(tool)) return undefined;
  if (tool === "tanren.read_run" && typeof args.runId === "string") return `/runs/${args.runId}`;
  if (tool === "tanren.read_spec" && typeof args.specId === "string") return `/specs/${args.specId}`;
  if (tool === "tanren.read_costs") return "/costs";
  if (tool === "tanren.read_insights" || tool === "tanren.read_milestones") return "/overview";
  return undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface ChatHandlers {
  // Called when a chip is clicked — re-asks Forge with the chip text.
  onChip: (text: string) => void;
  // Called when an action card navigates (read action). Write actions are inert.
  onNavigate: (route: string) => void;
}

// Appends a user turn (the operator's question) to the chat container.
export function appendUserTurn(chat: HTMLElement, text: string): void {
  const row = el("div", "fc-msg user");
  row.appendChild(el("div", "who", "TW"));
  const col = el("div", "fc-col");
  col.appendChild(el("div", "fc-bubble", text));
  row.appendChild(col);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}

// Appends a forge turn rendered from a ForgeAnswer: answer bubble, the first
// action card (auto-navigate / inert), and follow-up chips.
export function appendForgeTurn(chat: HTMLElement, answer: ForgeAnswer, handlers: ChatHandlers): void {
  const row = el("div", "fc-msg forge");
  row.appendChild(el("div", "who", "鍛"));
  const col = el("div", "fc-col");

  const bubble = el("div", "fc-bubble");
  bubble.innerHTML = answer.body;
  col.appendChild(bubble);

  const card = firstActionCard(answer);
  if (card !== undefined) {
    col.appendChild(buildCard(card, handlers));
  }

  if (answer.prompts.length > 0) {
    const chips = el("div", "fc-chips");
    for (const prompt of answer.prompts) {
      const chip = el("span", "chip");
      chip.appendChild(el("span", "pre", "↑"));
      chip.appendChild(document.createTextNode(` ${prompt}`));
      chip.addEventListener("click", () => handlers.onChip(prompt));
      chips.appendChild(chip);
    }
    col.appendChild(chips);
  }

  row.appendChild(col);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}

// The card the design surfaces: the first attention item (or insight) that
// carries an action. Read actions auto-navigate; write actions are inert.
function firstActionCard(answer: ForgeAnswer): { title: string; action: ForgeAction } | undefined {
  for (const item of answer.attentionItems) {
    if (item.action !== undefined) return { title: item.title, action: item.action };
  }
  for (const insight of answer.insights ?? []) {
    const action = insight.actions[0];
    if (action !== undefined) return { title: insight.title, action };
  }
  return undefined;
}

function buildCard(card: { title: string; action: ForgeAction }, handlers: ChatHandlers): HTMLElement {
  const route = routeForAction(card.action);
  const node = el("div", route !== undefined ? "fc-card" : "fc-card inert");
  node.appendChild(el("div", "lbl", route !== undefined ? "▸ auto-navigate" : "▸ action (coming soon)"));
  node.appendChild(el("div", "t", card.title));
  node.appendChild(el("div", "go", route !== undefined ? "↗" : "·"));
  if (route !== undefined) {
    node.addEventListener("click", () => handlers.onNavigate(route));
  }
  // Write-action cards are deliberately non-interactive (deferred).
  return node;
}

export function appendPending(chat: HTMLElement): HTMLElement {
  const row = el("div", "fc-msg forge pending");
  row.appendChild(el("div", "who", "鍛"));
  const col = el("div", "fc-col");
  col.appendChild(el("div", "fc-bubble", "…"));
  row.appendChild(col);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  return row;
}

// POSTs the question to the dashboard's forge-ask proxy. Returns undefined on
// failure so the caller can render a graceful fallback bubble.
export async function askForge(
  orgId: string,
  question: string,
  scope: { projectId?: string; threadId?: string }
): Promise<ForgeAskResponse | undefined> {
  if (orgId === "") return undefined;
  const body: Record<string, unknown> = { orgId, question };
  if (scope.projectId !== undefined && scope.projectId !== "") body.projectId = scope.projectId;
  if (scope.threadId !== undefined) body.threadId = scope.threadId;
  try {
    const response = await fetch("/forge/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) return undefined;
    return (await response.json()) as ForgeAskResponse;
  } catch {
    return undefined;
  }
}
