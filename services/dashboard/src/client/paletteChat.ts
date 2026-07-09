/**
 * thick-Forge chat island helper — the chat-mode half of the ⌘K
 * palette, split out of `palette.ts` to keep both under the 500-line cap.
 *
 * Owns the chat thread DOM: appends user + forge turns, renders the answer
 * bubble, follow-up chips, and auto-navigate action cards from a ForgeAnswer,
 * and POSTs questions to the dashboard's `/forge/ask` proxy (which forwards the
 * cookie to the orchestrator's LLM-backed conversation endpoint).
 *
 * Action cards: a card whose toolCall is a READ tool maps to an in-shell route
 * and navigates on click (auto-navigate). WRITE actions the answerer PROPOSES
 * (create_spec / trigger_run / rerun_task / acknowledge_insight) are now LIVE
 * (write-action approval): each pending proposal renders an
 * approve/reject card that POSTs to the dashboard's same-origin proposal proxy.
 * The model proposed; a human decides; the orchestrator executes under the
 * approving operator's authz.
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

export interface ForgeProposal {
  id: string;
  toolName: string;
  rationale: string;
  status: string;
  error?: string | null;
}

interface ForgeAskResponse {
  threadId: string;
  answer: ForgeAnswer;
  toolsUsed: string[];
  proposals: ForgeProposal[];
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
  "repo.read_issue",
]);

// Maps a READ-tool action to an in-shell route so an action card can auto-
// navigate. Write tools return undefined (inert card). Mirrors the routes the
// shell exposes for runs/specs/costs.
export function routeForAction(action: ForgeAction): string | undefined {
  const { tool, args = {} } = action.toolCall;
  if (!READ_TOOLS.has(tool)) return undefined;
  if (tool === "tanren.read_run" && typeof args["runId"] === "string") return `/runs/${args["runId"]}`;
  if (tool === "tanren.read_spec" && typeof args["specId"] === "string") return `/specs/${args["specId"]}`;
  if (tool === "tanren.read_costs") return "/costs";
  if (tool === "tanren.read_insights" || tool === "tanren.read_milestones") return "/overview";
  return undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
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
  row.append(el("div", "who", "TW"));
  const col = el("div", "fc-col");
  col.append(el("div", "fc-bubble", text));
  row.append(col);
  chat.append(row);
  chat.scrollTop = chat.scrollHeight;
}

// Appends a forge turn rendered from a ForgeAnswer: answer bubble, the first
// action card (auto-navigate / inert), and follow-up chips.
export function appendForgeTurn(chat: HTMLElement, answer: ForgeAnswer, handlers: ChatHandlers): void {
  const row = el("div", "fc-msg forge");
  row.append(el("div", "who", "鍛"));
  const col = el("div", "fc-col");

  const bubble = el("div", "fc-bubble");
  bubble.innerHTML = answer.body;
  col.append(bubble);

  const card = firstActionCard(answer);
  if (card !== undefined) {
    col.append(buildCard(card, handlers));
  }

  if (answer.prompts.length > 0) {
    const chips = el("div", "fc-chips");
    for (const prompt of answer.prompts) {
      const chip = el("span", "chip");
      chip.append(el("span", "pre", "↑"));
      chip.append(document.createTextNode(` ${prompt}`));
      chip.addEventListener("click", () => handlers.onChip(prompt));
      chips.append(chip);
    }
    col.append(chips);
  }

  row.append(col);
  chat.append(row);
  chat.scrollTop = chat.scrollHeight;
}

// Renders the pending write proposals the answerer raised as LIVE approve/
// reject cards (write-action approval). Each decision POSTs to the
// dashboard's same-origin proxy; the card updates in place to the resulting
// status (executed / rejected / failed / already-decided) without re-asking.
const STATUS_LABEL: Record<string, string> = {
  pending: "awaiting your approval",
  approved: "approved",
  executed: "✓ approved · executed",
  rejected: "✕ rejected",
  failed: "⚠ failed",
};

export function appendProposals(chat: HTMLElement, orgId: string, proposals: ForgeProposal[]): void {
  const pending = proposals.filter((p) => p.status === "pending");
  if (pending.length === 0) return;
  const row = el("div", "fc-msg forge");
  row.append(el("div", "who", "鍛"));
  const col = el("div", "fc-col");
  for (const proposal of pending) {
    col.append(buildProposalCard(orgId, proposal));
  }
  row.append(col);
  chat.append(row);
  chat.scrollTop = chat.scrollHeight;
}

function buildProposalCard(orgId: string, proposal: ForgeProposal): HTMLElement {
  const node = el("div", "fc-card proposal");
  node.dataset["proposalId"] = proposal.id;
  node.append(el("div", "lbl", "▸ proposed action"));
  node.append(el("div", "t", proposal.toolName));
  node.append(el("div", "d", proposal.rationale));
  const status = el("div", "fc-proposal-status", STATUS_LABEL[proposal.status] ?? proposal.status);
  const actions = el("div", "fc-proposal-actions");
  const approve = el("button", "btn primary", "approve");
  const reject = el("button", "btn ghost", "reject");
  approve.type = "button";
  reject.type = "button";
  const decide = (decision: "approve" | "reject"): void => {
    approve.disabled = true;
    reject.disabled = true;
    void decideProposal(orgId, proposal.id, decision).then((outcome) => {
      status.textContent = STATUS_LABEL[outcome] ?? outcome;
      node.classList.add("decided");
    });
  };
  approve.addEventListener("click", () => decide("approve"));
  reject.addEventListener("click", () => decide("reject"));
  actions.append(approve);
  actions.append(reject);
  node.append(actions);
  node.append(status);
  return node;
}

/**
 * Read the session CSRF token the shell embeds (`meta[name=csrf-token]` or
 * `body[data-csrf-token]`). Empty when unauthenticated / local-dev actor.
 */
export function readShellCsrfToken(doc?: Document): string {
  const page = doc ?? (typeof document === "undefined" ? undefined : document);
  if (page === undefined) return "";
  const meta = page.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  if (meta !== null && meta !== undefined && meta !== "") return meta;
  return page.body?.dataset["csrfToken"] ?? "";
}

/**
 * JSON write headers including x-csrf-token when a token is present.
 * Pure: pass `token` (or leave default to read from the shell DOM).
 */
export function csrfWriteHeaders(token: string = readShellCsrfToken()): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== "") headers["x-csrf-token"] = token;
  return headers;
}

/** Operator-visible forge-tool failure body (palette never silent-closes on error). */
export function forgeToolFailureMessage(status: number): string {
  return `Tool failed${status > 0 ? ` (${status})` : ""} — try again.`;
}

// POSTs the decision to the dashboard proxy and resolves to the resulting
// status string for the card. 409 (already decided) and 403 (denied) are
// surfaced honestly so the operator sees the terminal state, never a re-run.
async function decideProposal(orgId: string, proposalId: string, decision: "approve" | "reject"): Promise<string> {
  try {
    const response = await fetch(`/forge/proposals/${decision}`, {
      method: "POST",
      headers: csrfWriteHeaders(),
      body: JSON.stringify({ orgId, proposalId }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      proposal?: { status?: string };
      outcome?: string;
      currentStatus?: string;
    };
    if (response.ok) return body.proposal?.status ?? (decision === "approve" ? "executed" : "rejected");
    if (response.status === 409) return body.currentStatus ?? "already decided";
    if (response.status === 403) return "denied";
    return "failed";
  } catch {
    return "failed";
  }
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
  const node = el("div", route === undefined ? "fc-card inert" : "fc-card");
  node.append(el("div", "lbl", route === undefined ? "▸ action (coming soon)" : "▸ auto-navigate"));
  node.append(el("div", "t", card.title));
  node.append(el("div", "go", route === undefined ? "·" : "↗"));
  if (route !== undefined) {
    node.addEventListener("click", () => handlers.onNavigate(route));
  }
  // Write-action cards are deliberately non-interactive (deferred).
  return node;
}

export function appendPending(chat: HTMLElement): HTMLElement {
  const row = el("div", "fc-msg forge pending");
  row.append(el("div", "who", "鍛"));
  const col = el("div", "fc-col");
  col.append(el("div", "fc-bubble", "…"));
  row.append(col);
  chat.append(row);
  chat.scrollTop = chat.scrollHeight;
  return row;
}

// POSTs the question to the dashboard's forge-ask proxy. Returns undefined on
// failure so the caller can render a graceful fallback bubble.
export async function askForge(
  orgId: string,
  question: string,
  scope: { projectId?: string; threadId?: string },
): Promise<ForgeAskResponse | undefined> {
  if (orgId === "") return undefined;
  const body: Record<string, unknown> = { orgId, question };
  if (scope["projectId"] !== undefined && scope["projectId"] !== "") body["projectId"] = scope["projectId"];
  if (scope["threadId"] !== undefined) body["threadId"] = scope["threadId"];
  try {
    const response = await fetch("/forge/ask", {
      method: "POST",
      headers: csrfWriteHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as ForgeAskResponse;
  } catch {
    return undefined;
  }
}
