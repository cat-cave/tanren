// ds-2 — additive Writer prompt context for a resolved web design artifact.

import type { WebComponentCatalog } from "./webCatalog.js";
import type { WebTokenBinding } from "./webTokens.js";

export interface WebDesignWriterContext {
  readonly designSystemId: string;
  readonly releaseId: string;
  readonly artifactId: string;
  readonly catalog: WebComponentCatalog;
  readonly tokens: readonly WebTokenBinding[];
}

/** Render the reusable web source contract the Writer must author against. */
export function renderWebDesignSystemBlock(context: WebDesignWriterContext): string {
  const lines = [
    "Web design system — use this published system when authoring UI (additive to the design contract):",
    `Design system: ${context.designSystemId}; release: ${context.releaseId}; artifact: ${context.artifactId}`,
    "Use the CSS custom properties and catalog components below; do not invent parallel token names or substitute unlisted primitives.",
    "",
    "Resolved tokens:",
    ...context.tokens.map((token) => `- ${token.path}: ${token.cssVariable} = ${token.cssValue}`),
    "",
    "Available shadcn/Radix catalog components:",
    ...context.catalog.components.map(
      (component) =>
        `- ${component.key} (${component.primitive}; ${component.sourcePath}) — ${renderBindings(component.tokenBindings)}`,
    ),
  ];
  return lines.join("\n");
}

function renderBindings(bindings: Readonly<Record<string, string>>): string {
  return Object.entries(bindings)
    .map(([role, token]) => `${role} → ${token}`)
    .join(", ");
}
