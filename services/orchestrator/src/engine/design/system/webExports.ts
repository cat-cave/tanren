// ds-2 — deterministic CSS, Tailwind, DTCG, and shadcn-registry export projections.

import type { WebComponentCatalog } from "./webCatalog.js";
import type { WebArtifactSourceFile } from "./webFiles.js";
import type { WebTokenProjection } from "./webTokens.js";

export const WEB_EXPORT_FORMATS = ["css", "tailwind", "dtcg", "shadcn-registry"] as const;
export type WebExportFormat = (typeof WEB_EXPORT_FORMATS)[number];

export interface WebExportProjection {
  readonly id: WebExportFormat;
  readonly file: WebArtifactSourceFile;
}

export function projectWebExports(
  tokens: WebTokenProjection,
  catalog: WebComponentCatalog,
): readonly WebExportProjection[] {
  return [
    {
      id: "css",
      file: { path: "exports/tokens.css", kind: "export", mediaType: "text/css", source: tokens.css },
    },
    {
      id: "tailwind",
      file: {
        path: "exports/tailwind.config.ts",
        kind: "export",
        mediaType: "text/plain",
        source: tokens.tailwindConfig,
      },
    },
    {
      id: "dtcg",
      file: {
        path: "exports/design.tokens.json",
        kind: "export",
        mediaType: "application/json",
        source: tokens.dtcgExport,
      },
    },
    {
      id: "shadcn-registry",
      file: {
        path: "exports/shadcn-registry.json",
        kind: "export",
        mediaType: "application/json",
        source: `${JSON.stringify(shadcnRegistry(catalog), null, 2)}\n`,
      },
    },
  ];
}

export function isWebExportFormat(format: string): format is WebExportFormat {
  return (WEB_EXPORT_FORMATS as readonly string[]).includes(format);
}

function shadcnRegistry(catalog: WebComponentCatalog): Record<string, unknown> {
  return {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: "tanren-web-design-system",
    homepage: "https://tanren.dev/design-system",
    items: catalog.components.map((component) => ({
      name: component.key,
      type: "registry:ui",
      dependencies: [component.packageName],
      files: [{ path: component.sourcePath, type: "registry:ui" }],
      meta: { primitive: component.primitive, tokenBindings: component.tokenBindings },
    })),
  };
}
