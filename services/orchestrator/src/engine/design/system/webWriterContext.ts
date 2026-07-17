// ds-2 — additive Writer prompt context for a resolved web design artifact.

import { z } from "zod";
import { WEB_CATALOG_SCHEMA_VERSION, type WebComponentCatalog } from "./webCatalog.js";
import type { WebTokenBinding } from "./webTokens.js";

export interface WebDesignWriterContext {
  readonly designSystemId: string;
  readonly releaseId: string;
  readonly artifactId: string;
  readonly catalog: WebComponentCatalog;
  readonly tokens: readonly WebTokenBinding[];
}

// This is persisted alongside the immutable artifact metadata so the run worker
// can inject the exact generated token/catalog projection without re-running the
// adapter (or depending on an object-store read during prompt assembly).
const WebTokenBindingSchema = z
  .object({
    path: z.string().min(1),
    cssVariable: z.string().min(1),
    cssValue: z.string(),
    type: z.string().min(1).optional(),
  })
  .strict();

const WebComponentCatalogSchema = z
  .object({
    schemaVersion: z.literal(WEB_CATALOG_SCHEMA_VERSION),
    framework: z.literal("react"),
    style: z.literal("shadcn"),
    components: z.array(
      z
        .object({
          key: z.string().min(1),
          primitive: z.string().min(1),
          packageName: z.string().min(1),
          sourcePath: z.string().min(1),
          tokenBindings: z.record(z.string(), z.string()),
        })
        .strict(),
    ),
  })
  .strict();

export const WebDesignWriterContextSchema = z
  .object({
    designSystemId: z.string().min(1),
    releaseId: z.string().min(1),
    artifactId: z.string().min(1),
    catalog: WebComponentCatalogSchema,
    tokens: z.array(WebTokenBindingSchema),
  })
  .strict();

/** Parse a persisted web projection before it can reach a Writer prompt. */
export function parseWebDesignWriterContext(value: unknown): WebDesignWriterContext {
  return WebDesignWriterContextSchema.parse(value) as WebDesignWriterContext;
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
