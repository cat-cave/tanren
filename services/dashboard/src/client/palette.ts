/**
 * Forge palette island (⌘K). Hydrates the server-rendered palette markup and
 * the P3-0010 chat morph:
 *   - ⌘K / Ctrl+K toggles the overlay anywhere in the shell; the "ask forge"
 *     trigger and Escape / backdrop-click close it;
 *   - typing filters items by title/desc;
 *   - ↑/↓ moves the active item, Enter selects;
 *   - selecting a read item (`data-route`) navigates; a write item
 *     (`data-tool`) POSTs to the orchestrator operator-button endpoint;
 *   - selecting an ASK item (no route/tool) — or pressing ↵ on no match —
 *     MORPHS the palette in place into a chat thread backed by the thick-Forge
 *     conversation endpoint, rendering forge turns, follow-up chips, and
 *     auto-navigate action cards (chat rendering lives in `paletteChat.ts`).
 *
 * Items + grouping are rendered by the server; this island never invents a
 * palette action — it can only act on the `data-route`/`data-tool` the server
 * emitted, which keeps the palette inside the declared Forge tool surface
 * (P2A-0019). Chat answers come from the orchestrator (the model never runs in
 * the browser).
 */

import { appendForgeTurn, appendPending, appendUserTurn, askForge } from "./paletteChat.js";

interface PaletteRefs {
  root: HTMLElement;
  modal: HTMLElement;
  input: HTMLInputElement;
  results: HTMLElement;
  empty: HTMLElement;
  back: HTMLElement;
  chat: HTMLElement;
  footerPalette: HTMLElement;
  footerChat: HTMLElement;
  orgId: string;
  projectId: string;
}

function getRefs(): PaletteRefs | undefined {
  const root = document.querySelector<HTMLElement>('[data-island="palette"]');
  if (root === null) return undefined;
  const modal = root.querySelector<HTMLElement>("[data-palette-modal]");
  const input = root.querySelector<HTMLInputElement>("[data-palette-input]");
  const results = root.querySelector<HTMLElement>("[data-palette-results]");
  const empty = root.querySelector<HTMLElement>("[data-palette-empty]");
  const back = root.querySelector<HTMLElement>("[data-palette-back]");
  const chat = root.querySelector<HTMLElement>("[data-palette-chat]");
  const footerPalette = root.querySelector<HTMLElement>("[data-palette-footer-palette]");
  const footerChat = root.querySelector<HTMLElement>("[data-palette-footer-chat]");
  if (modal === null || input === null || results === null || empty === null) return undefined;
  if (back === null || chat === null || footerPalette === null || footerChat === null) return undefined;
  return {
    root,
    modal,
    input,
    results,
    empty,
    back,
    chat,
    footerPalette,
    footerChat,
    orgId: root.dataset.orgId ?? "",
    projectId: root.dataset.projectId ?? ""
  };
}

function items(refs: PaletteRefs): HTMLElement[] {
  return [...refs.results.querySelectorAll<HTMLElement>("[data-palette-item]")];
}

function visibleItems(refs: PaletteRefs): HTMLElement[] {
  return items(refs).filter((el) => !el.hidden);
}

// Hard navigation to an in-shell route (action-card auto-navigate). Module-
// scoped — it captures nothing from the island closure.
function navigate(route: string): void {
  if (route !== "") window.location.href = route;
}

export function initPalette(): void {
  const refs = getRefs();
  if (refs === undefined) return;
  let active = 0;
  // Chat-mode state: the active thread id (so follow-ups continue the same
  // thread) and whether we have morphed into chat.
  let inChat = false;
  let threadId: string | undefined;

  const setMode = (chat: boolean): void => {
    inChat = chat;
    refs.modal.classList.toggle("chat-mode", chat);
    refs.results.hidden = chat;
    refs.chat.hidden = !chat;
    refs.back.hidden = !chat;
    refs.footerPalette.hidden = chat;
    refs.footerChat.hidden = !chat;
    refs.input.placeholder = chat ? "follow up · ↵ to send" : "ask, command, or describe…";
  };

  const exitChat = (): void => {
    threadId = undefined;
    refs.chat.replaceChildren();
    refs.input.value = "";
    setMode(false);
    filter();
  };

  // Sends one question to Forge: morph to chat, render the user turn + a pending
  // placeholder, then replace it with the forge turn (or a fallback bubble).
  const send = async (question: string): Promise<void> => {
    if (question.trim() === "") return;
    if (!inChat) setMode(true);
    refs.input.value = "";
    appendUserTurn(refs.chat, question);
    const pending = appendPending(refs.chat);
    const response = await askForge(refs.orgId, question, {
      projectId: refs.projectId === "" ? undefined : refs.projectId,
      threadId
    });
    pending.remove();
    if (response === undefined) {
      const fallback = { body: "I couldn't reach Forge just now — try again.", attentionItems: [], prompts: [] };
      appendForgeTurn(refs.chat, fallback, { onChip: (t) => void send(t), onNavigate: (route) => navigate(route) });
      return;
    }
    threadId = response.threadId;
    appendForgeTurn(refs.chat, response.answer, {
      onChip: (text) => void send(text),
      onNavigate: (route) => navigate(route)
    });
  };

  const setActive = (index: number): void => {
    const vis = visibleItems(refs);
    if (vis.length === 0) return;
    active = Math.max(0, Math.min(vis.length - 1, index));
    for (const el of items(refs)) el.classList.remove("active");
    const el = vis[active];
    if (el !== undefined) {
      el.classList.add("active");
      el.scrollIntoView({ block: "nearest" });
    }
  };

  const filter = (): void => {
    const query = refs.input.value.trim().toLowerCase();
    let shown = 0;
    for (const el of items(refs)) {
      const hit =
        query === "" ||
        (el.dataset.title ?? "").includes(query) ||
        (el.dataset.desc ?? "").includes(query);
      el.hidden = !hit;
      if (hit) shown += 1;
    }
    // Hide group headers whose items are all filtered out.
    for (const group of refs.results.querySelectorAll<HTMLElement>("[data-group]")) {
      let next = group.nextElementSibling as HTMLElement | null;
      let anyVisible = false;
      while (next !== null && next.hasAttribute("data-palette-item")) {
        if (!next.hidden) anyVisible = true;
        next = next.nextElementSibling as HTMLElement | null;
      }
      group.hidden = !anyVisible;
    }
    refs.empty.hidden = shown !== 0;
    setActive(0);
  };

  // `prefill` seeds the input (e.g. the costs heatmap's "schedule overnight
  // audits" affordance opens the palette pre-typed with the audit prompt). The
  // server emits the seed text via `data-palette-prefill`; the island only types
  // it — it never invents an action beyond the rendered items.
  const open = (prefill = ""): void => {
    refs.root.hidden = false;
    refs.input.value = prefill;
    setMode(false);
    filter();
    setTimeout(() => {
      refs.input.focus();
      if (prefill !== "") refs.input.setSelectionRange(prefill.length, prefill.length);
    }, 30);
  };
  const close = (): void => {
    refs.root.hidden = true;
    // Reset to palette mode + clear the thread so the next open starts fresh.
    threadId = undefined;
    refs.chat.replaceChildren();
    setMode(false);
  };

  const select = async (el: HTMLElement): Promise<void> => {
    const route = el.dataset.route ?? "";
    const tool = el.dataset.tool ?? "";
    const isAsk = (el.dataset.ask ?? "") === "1";
    if (tool !== "" && refs.orgId !== "") {
      let args: Record<string, unknown> = {};
      try {
        args = el.dataset.args ? (JSON.parse(el.dataset.args) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      await fetch(`/forge/tools`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: refs.orgId, tool, args })
      }).catch(() => undefined);
      close();
      return;
    }
    if (route !== "") {
      window.location.href = route;
      return;
    }
    // ask-forge item (no route, no tool) → morph to chat with its title.
    if (isAsk) {
      const title = el.querySelector<HTMLElement>(".t")?.textContent ?? refs.input.value;
      void send(title);
      return;
    }
    close();
  };

  refs.input.addEventListener("input", filter);

  refs.results.addEventListener("click", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-palette-item]");
    if (el !== null) void select(el);
  });

  refs.root.addEventListener("click", (event) => {
    if (!refs.modal.contains(event.target as Node)) close();
  });

  refs.back.addEventListener("click", () => exitChat());

  refs.input.addEventListener("keydown", (event) => {
    // In chat mode the input is a "follow up" composer: Enter sends, Escape
    // backs out to the palette (a second Escape closes — handled globally).
    if (inChat) {
      if (event.key === "Enter") {
        event.preventDefault();
        void send(refs.input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        exitChat();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const el = visibleItems(refs)[active];
      if (el !== undefined) {
        void select(el);
      } else if (refs.input.value.trim() !== "") {
        // No matching command → ask Forge with the free-text query.
        void send(refs.input.value.trim());
      }
    } else if (event.key === "Escape") {
      close();
    }
  });

  // Trigger button(s) — the "ask forge" key in the top bar, plus any affordance
  // carrying a `data-palette-prefill` seed (e.g. the costs heatmap audits CTA).
  for (const trigger of document.querySelectorAll<HTMLElement>('[data-island-trigger="palette"]')) {
    trigger.addEventListener("click", () => open(trigger.dataset.palettePrefill ?? ""));
  }

  // Global ⌘K / Ctrl+K toggle, Escape to close.
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (refs.root.hidden) open();
      else close();
    } else if (event.key === "Escape" && !refs.root.hidden) {
      close();
    }
  });
}
