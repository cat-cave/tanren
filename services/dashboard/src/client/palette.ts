/**
 * Forge palette island (⌘K). Hydrates the server-rendered palette markup:
 *   - ⌘K / Ctrl+K toggles the overlay anywhere in the shell; the "ask forge"
 *     trigger and Escape / backdrop-click close it;
 *   - typing filters items by title/desc;
 *   - ↑/↓ moves the active item, Enter selects;
 *   - selecting a read item (`data-route`) navigates; a write item
 *     (`data-tool`) POSTs to the orchestrator operator-button endpoint, then
 *     navigates to a sensible follow-up.
 *
 * Items + grouping are rendered by the server; this island never invents an
 * action — it can only act on the `data-route`/`data-tool` the server emitted,
 * which keeps the palette inside the declared Forge tool surface (P2A-0019).
 */

interface PaletteRefs {
  root: HTMLElement;
  modal: HTMLElement;
  input: HTMLInputElement;
  results: HTMLElement;
  empty: HTMLElement;
  orgId: string;
}

function getRefs(): PaletteRefs | undefined {
  const root = document.querySelector<HTMLElement>('[data-island="palette"]');
  if (root === null) return undefined;
  const modal = root.querySelector<HTMLElement>("[data-palette-modal]");
  const input = root.querySelector<HTMLInputElement>("[data-palette-input]");
  const results = root.querySelector<HTMLElement>("[data-palette-results]");
  const empty = root.querySelector<HTMLElement>("[data-palette-empty]");
  if (modal === null || input === null || results === null || empty === null) return undefined;
  return { root, modal, input, results, empty, orgId: root.dataset.orgId ?? "" };
}

function items(refs: PaletteRefs): HTMLElement[] {
  return [...refs.results.querySelectorAll<HTMLElement>("[data-palette-item]")];
}

function visibleItems(refs: PaletteRefs): HTMLElement[] {
  return items(refs).filter((el) => !el.hidden);
}

export function initPalette(): void {
  const refs = getRefs();
  if (refs === undefined) return;
  let active = 0;

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
    filter();
    setTimeout(() => {
      refs.input.focus();
      if (prefill !== "") refs.input.setSelectionRange(prefill.length, prefill.length);
    }, 30);
  };
  const close = (): void => {
    refs.root.hidden = true;
  };

  const select = async (el: HTMLElement): Promise<void> => {
    const route = el.dataset.route ?? "";
    const tool = el.dataset.tool ?? "";
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

  refs.input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const el = visibleItems(refs)[active];
      if (el !== undefined) void select(el);
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
