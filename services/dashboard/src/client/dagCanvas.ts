/**
 * DAG-canvas island (P3-0013). Hydrates the server-rendered DAG-primary view:
 *   - mode persistence: the chat↔DAG choice is stored in localStorage + a
 *     cookie (like the theme toggle) so the server renders the right mode on
 *     the next load; the toggle links carry `?mode=` as the no-JS fallback;
 *   - group-by (milestone/behavior/priority): re-lays-out the embedded DAG
 *     model client-side and re-renders the SVG, no re-fetch;
 *   - zoom (+/−) + fit + drag-to-pan on the canvas;
 *   - node / needs-strip / dep-chip click → fetch the spec-drawer fragment and
 *     slide it in; Escape / backdrop / ✕ close it; dep chips walk the graph.
 *
 * The model is embedded as JSON on the root (`data-dag`), so the island never
 * re-fetches the graph. It can only act on data the server emitted.
 */

import type { ProjectDag } from "../api/dagTypes.js";
import { layoutDag, type DagLayout, type GroupBy } from "../components/project/dagLayout.js";

const MODE_KEY = "tanren_project_mode";

const STATUS_FILL: Record<string, string> = {
  done: "oklch(58% 0.18 155 / 0.14)",
  live: "var(--accent-tint)",
  review: "oklch(70% 0.16 75 / 0.22)",
  blocked: "oklch(60% 0.18 25 / 0.14)",
  queued: "var(--bg-canvas)",
};
const STATUS_STROKE: Record<string, string> = {
  done: "var(--status-ok, oklch(58% 0.18 155))",
  live: "var(--ember-08)",
  review: "var(--status-warn, oklch(70% 0.16 75))",
  blocked: "var(--status-fail, oklch(60% 0.18 25))",
  queued: "var(--line-2)",
};
const STATUS_TEXT: Record<string, string> = {
  done: "var(--fg-2)",
  live: "var(--ember-08)",
  review: "var(--status-warn, oklch(70% 0.16 75))",
  blocked: "var(--status-fail, oklch(60% 0.18 25))",
  queued: "var(--fg-3)",
};
const STATUS_GLYPH: Record<string, string> = {
  done: "✓",
  live: "↻",
  review: "!",
  blocked: "⏳",
  queued: "○",
};
const PULSE: Record<string, string> = {
  live: "var(--ember-08)",
  review: "var(--status-warn, oklch(70% 0.16 75))",
  blocked: "var(--status-fail, oklch(60% 0.18 25))",
};

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function trunc(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function headerColor(status: string, attention: number | null): string {
  if (status === "live") return "var(--ember-08)";
  if (status === "review") return "var(--status-warn, oklch(70% 0.16 75))";
  if (status === "done") return "var(--status-ok, oklch(58% 0.18 155))";
  if (attention !== null) return "var(--status-warn, oklch(70% 0.16 75))";
  return "var(--fg-3)";
}

function renderSvg(layout: DagLayout): string {
  const headers = layout.headers
    .map((h) => {
      const color = headerColor(h.status, h.attention);
      const badge =
        h.attention !== null
          ? `<g transform="translate(${h.cx + 44}, 18)"><circle r="10" fill="var(--status-warn, oklch(70% 0.16 75))" stroke="var(--bg-canvas)" stroke-width="2"/><text x="0" y="3.5" fill="var(--accent-on)" font-family="var(--font-mono)" font-size="10" font-weight="700" text-anchor="middle">${h.attention}</text></g>`
          : "";
      return `${badge}<text x="${h.cx}" y="40" fill="${color}" font-family="var(--font-mono)" font-size="10" text-anchor="middle" letter-spacing="0.18em" font-weight="700">${esc(trunc(h.label, 16))}</text>`;
    })
    .join("");

  const edges = layout.edges
    .map((e) => {
      const stroke = e.hot ? "var(--ember-08)" : "var(--line-2)";
      const marker = e.hot ? "url(#dag-arr-hot)" : "url(#dag-arr-cool)";
      return `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${stroke}" stroke-width="${e.hot ? 1.5 : 1}" marker-end="${marker}"/>`;
    })
    .join("");

  const nodes = layout.nodes
    .map((p) => {
      const n = p.node;
      const pulse = PULSE[n.status];
      const pulseRect =
        pulse !== undefined
          ? `<rect class="dag-pulse" x="-2" y="-2" width="${p.w + 4}" height="${p.h + 4}" rx="3" fill="none" stroke="${pulse}" stroke-width="1.5" opacity="0.6"><animate attributeName="opacity" values="0.6;0;0.6" dur="1.6s" repeatCount="indefinite"/><animate attributeName="stroke-width" values="1.5;3;1.5" dur="1.6s" repeatCount="indefinite"/></rect>`
          : "";
      const crit = n.onCriticalPath ? `<rect x="0" y="0" width="3" height="${p.h}" fill="var(--ember-08)"/>` : "";
      const attn =
        n.attention !== null
          ? `<g transform="translate(${p.w - 5}, -3)"><circle r="9" fill="var(--ember-08)" stroke="var(--bg-canvas)" stroke-width="2"/><text x="0" y="3.5" fill="var(--accent-on)" font-family="var(--font-mono)" font-size="10" font-weight="700" text-anchor="middle">${n.attention}</text></g>`
          : "";
      return `<g class="dag-node" data-spec-id="${esc(n.id)}" data-status="${n.status}" transform="translate(${p.x}, ${p.y})" role="button" tabindex="0" aria-label="${esc(n.status)} spec ${esc(n.title)}">${pulseRect}<rect width="${p.w}" height="${p.h}" rx="2" fill="${STATUS_FILL[n.status]}" stroke="${STATUS_STROKE[n.status]}" stroke-width="${pulse !== undefined ? 1.5 : 1}"/>${crit}<text x="9" y="17" fill="${STATUS_TEXT[n.status]}" font-family="var(--font-mono)" font-size="10">${esc(`${STATUS_GLYPH[n.status]} ${trunc(n.title, 16)}`)}</text>${attn}</g>`;
    })
    .join("");

  return `<defs><marker id="dag-arr-cool" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="var(--line-2)"/></marker><marker id="dag-arr-hot" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="var(--ember-08)"/></marker></defs><g data-dag-pan><g class="dag-headers">${headers}</g><g class="dag-edges">${edges}</g><g class="dag-nodes">${nodes}</g></g>`;
}

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

function applyTransform(pan: SVGGElement, view: ViewState): void {
  pan.setAttribute("transform", `translate(${view.panX}, ${view.panY}) scale(${view.zoom})`);
}

function persistMode(mode: "chat" | "dag"): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // cookie still carries it
  }
  document.cookie = `${MODE_KEY}=${mode}; path=/; max-age=31536000; samesite=lax`;
}

async function openDrawer(root: HTMLElement, projectId: string, specId: string): Promise<void> {
  closeDrawer();
  let html = "";
  try {
    const res = await fetch(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/drawer`, {
      headers: { accept: "text/html" },
    });
    if (!res.ok) return;
    html = await res.text();
  } catch {
    return;
  }
  const host = document.createElement("div");
  host.dataset["dagDrawerHost"] = "1";
  host.innerHTML = html;
  document.body.appendChild(host);

  const scrim = host.querySelector<HTMLElement>("[data-spec-scrim]");
  const drawer = host.querySelector<HTMLElement>("[data-spec-drawer]");
  if (scrim !== null) {
    scrim.addEventListener("click", (event) => {
      if (event.target === scrim) closeDrawer();
    });
  }
  host.querySelector<HTMLButtonElement>("[data-spec-close]")?.addEventListener("click", () => closeDrawer());
  // Dependency chips walk the graph inside the drawer.
  if (drawer !== null) {
    for (const chip of drawer.querySelectorAll<HTMLElement>("[data-spec-id]")) {
      const next = chip.dataset["specId"];
      if (next === undefined || next === specId) continue;
      chip.addEventListener("click", () => void openDrawer(root, projectId, next));
    }
  }
}

function closeDrawer(): void {
  for (const host of document.querySelectorAll<HTMLElement>("[data-dag-drawer-host]")) {
    host.remove();
  }
}

function initModeToggle(): void {
  const toggle = document.querySelector<HTMLElement>("[data-mode-toggle]");
  if (toggle === null) return;
  for (const link of toggle.querySelectorAll<HTMLAnchorElement>("[data-mode-value]")) {
    link.addEventListener("click", () => {
      const mode = link.dataset["modeValue"] === "chat" ? "chat" : "dag";
      persistMode(mode);
    });
  }
}

export function initDagCanvas(): void {
  initModeToggle();

  const root = document.querySelector<HTMLElement>('[data-island="dag-canvas"]');
  if (root === null) return;

  const projectId = root.dataset["projectId"] ?? "";
  let dag: ProjectDag;
  try {
    dag = JSON.parse(root.dataset["dag"] ?? "{}") as ProjectDag;
  } catch {
    return;
  }

  const canvas = root.querySelector<HTMLElement>("[data-dag-canvas]");
  const svg = root.querySelector<SVGSVGElement>("[data-dag-svg]");
  let group: GroupBy = "milestone";
  const view: ViewState = { zoom: 1, panX: 0, panY: 0 };

  const relayout = (): void => {
    if (svg === null) return;
    const layout = layoutDag(dag, group);
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    svg.innerHTML = renderSvg(layout);
    wireNodes();
    const pan = svg.querySelector<SVGGElement>("[data-dag-pan]");
    if (pan !== null) applyTransform(pan, view);
  };

  const wireNodes = (): void => {
    for (const node of root.querySelectorAll<SVGGElement>(".dag-node[data-spec-id]")) {
      const specId = node.dataset["specId"];
      if (specId === undefined) continue;
      node.addEventListener("click", () => void openDrawer(root, projectId, specId));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openDrawer(root, projectId, specId);
        }
      });
    }
  };

  // Needs-strip items also open the drawer for their target node.
  for (const item of root.querySelectorAll<HTMLElement>(".needs-item[data-spec-id]")) {
    const specId = item.dataset["specId"];
    if (specId === undefined) continue;
    item.addEventListener("click", () => void openDrawer(root, projectId, specId));
  }

  // Group-by controls.
  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-group]")) {
    btn.addEventListener("click", () => {
      group = (btn.dataset["group"] as GroupBy) ?? "milestone";
      for (const other of root.querySelectorAll<HTMLButtonElement>("[data-group]")) {
        other.classList.toggle("active", other === btn);
      }
      relayout();
    });
  }

  // Zoom + fit controls.
  const pan = svg?.querySelector<SVGGElement>("[data-dag-pan]") ?? null;
  const setZoom = (next: number): void => {
    view.zoom = Math.min(2.5, Math.max(0.4, next));
    if (pan !== null) applyTransform(pan, view);
    else relayout();
  };
  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-zoom]")) {
    btn.addEventListener("click", () => {
      const kind = btn.dataset["zoom"];
      if (kind === "in") setZoom(view.zoom * 1.2);
      else if (kind === "out") setZoom(view.zoom / 1.2);
      else {
        view.zoom = 1;
        view.panX = 0;
        view.panY = 0;
        const cur = svg?.querySelector<SVGGElement>("[data-dag-pan]") ?? null;
        if (cur !== null) applyTransform(cur, view);
      }
    });
  }

  // Drag-to-pan.
  if (canvas !== null && svg !== null) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    canvas.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest(".dag-node") !== null) return;
      dragging = true;
      startX = event.clientX - view.panX;
      startY = event.clientY - view.panY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      view.panX = event.clientX - startX;
      view.panY = event.clientY - startY;
      const cur = svg.querySelector<SVGGElement>("[data-dag-pan]");
      if (cur !== null) applyTransform(cur, view);
    });
    const stop = (): void => {
      dragging = false;
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
  }

  // Escape closes the drawer anywhere.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });

  wireNodes();
}
