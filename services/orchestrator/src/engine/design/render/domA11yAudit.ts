// ds-4 sub-node #1 — the browser-free DOM + a11y capture over a rendered
// component. The SSR HTML is wrapped in a scenario-specific document (theme,
// viewport, locale) so distinct scenarios yield distinct capture bytes, loaded
// into jsdom (a real DOM), and audited by a REAL `axe-core` run.
//
// `color-contrast` is disabled: it needs pixel layout / canvas that jsdom does
// not provide — that concern belongs to the render-worker (browser) sub-node,
// not this browser-free DOM/a11y slice. Every other axe rule runs for real.

import { JSDOM } from "jsdom";
import axe from "axe-core";
import type { DesignRenderScenario } from "../system/designTargetAdapter.js";

interface ViewportSize {
  readonly width: number;
  readonly height: number;
}
const DESKTOP_VIEWPORT: ViewportSize = { width: 1280, height: 800 };
const MOBILE_VIEWPORT: ViewportSize = { width: 390, height: 844 };

/** Map a scenario viewport name to concrete window dimensions (unknown → desktop). */
function resolveViewport(name: string): ViewportSize {
  return name === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
}

/** Minimal shape of the axe result we read (axe runs inside the jsdom window). */
interface AxeNode {
  readonly target?: readonly string[];
  readonly failureSummary?: string;
}
interface AxeRuleResult {
  readonly id: string;
  readonly impact?: string | null;
  readonly help?: string;
  readonly nodes?: readonly AxeNode[];
}
interface AxeRunResult {
  readonly violations: readonly AxeRuleResult[];
  readonly passes: readonly AxeRuleResult[];
  readonly incomplete: readonly AxeRuleResult[];
  readonly testEngine: { readonly name: string; readonly version: string };
}

export interface DomA11yCapture {
  /** The full scenario-wrapped document HTML — the `dom_snapshot` capture bytes. */
  readonly documentHtml: string;
  /** The structured a11y audit — the `a11y_audit` capture bytes (before serialization). */
  readonly audit: {
    readonly scenarioKey: string;
    readonly component: string;
    readonly theme: string;
    readonly viewport: string;
    readonly locale: string;
    readonly engine: string;
    readonly engineVersion: string;
    readonly violationCount: number;
    readonly passCount: number;
    readonly incompleteCount: number;
    readonly violations: readonly {
      readonly id: string;
      readonly impact: string | null;
      readonly help: string;
      readonly targets: readonly string[];
    }[];
    readonly dom: {
      readonly elementCount: number;
      readonly tagInventory: Readonly<Record<string, number>>;
      readonly roles: readonly string[];
    };
  };
}

function scenarioDocument(componentHtml: string, scenario: DesignRenderScenario): string {
  const viewport = resolveViewport(scenario.viewport);
  return [
    "<!DOCTYPE html>",
    `<html lang="${escapeAttr(scenario.locale)}" data-theme="${escapeAttr(scenario.theme)}" class="${escapeAttr(scenario.theme)}">`,
    '<head><meta charset="utf-8">',
    `<meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">`,
    `<title>${escapeAttr(scenario.scenarioKey)}</title></head>`,
    `<body data-viewport="${escapeAttr(scenario.viewport)}">`,
    `<div id="scenario-root">${componentHtml}</div>`,
    "</body></html>",
  ].join("");
}

/**
 * Load the rendered component into jsdom and run a real axe audit. The window
 * width/height are set from the scenario viewport so the capture is scenario
 * specific. Returns the wrapped document HTML + the structured audit; the caller
 * stores both content-addressed.
 */
export async function captureDomA11y(componentHtml: string, scenario: DesignRenderScenario): Promise<DomA11yCapture> {
  const viewport = resolveViewport(scenario.viewport);
  const documentHtml = scenarioDocument(componentHtml, scenario);
  const dom = new JSDOM(documentHtml, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height });

  const root = window.document.querySelector("#scenario-root");
  if (root === null) throw new Error("scenario root missing after jsdom load");

  window.eval(axe.source);
  const runner = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<AxeRunResult> } }).axe;
  const result = await runner.run(root, { rules: { "color-contrast": { enabled: false } } });

  const domStats = collectDomStats(root);
  const audit: DomA11yCapture["audit"] = {
    scenarioKey: scenario.scenarioKey,
    component: scenario.component,
    theme: scenario.theme,
    viewport: scenario.viewport,
    locale: scenario.locale,
    engine: result.testEngine.name,
    engineVersion: result.testEngine.version,
    violationCount: result.violations.length,
    passCount: result.passes.length,
    incompleteCount: result.incomplete.length,
    violations: result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      help: violation.help ?? "",
      targets: (violation.nodes ?? []).flatMap((node) => node.target ?? []).map(String),
    })),
    dom: domStats,
  };
  dom.window.close();
  return { documentHtml, audit };
}

function collectDomStats(root: Element): DomA11yCapture["audit"]["dom"] {
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  const tagInventory: Record<string, number> = {};
  const roles = new Set<string>();
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    tagInventory[tag] = (tagInventory[tag] ?? 0) + 1;
    const role = element.getAttribute("role");
    if (role !== null && role.trim() !== "") roles.add(role.trim());
  }
  return { elementCount: elements.length, tagInventory, roles: [...roles].sort() };
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
