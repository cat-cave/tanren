// ds-7 — document-media framework adapter. Projects the resolved DTCG token
// set onto a document/media stylesheet (PDF/Word/print-ready CSS) + a minimal
// document-template catalog. REAL but small — the projection is content, not a
// runnable build (the conformance receipt reflects that: build verification is
// document-render, not cargo/xcode/gradle).

import { FrameworkDesignTargetAdapter, type FrameworkAdapterSpec } from "./frameworkAdapterCore.js";

export const DOCUMENT_MEDIA_DESIGN_TARGET = "document-media" as const;

const DOCUMENT_MEDIA_CAPABILITIES = [
  "tokens",
  "catalog",
  "components",
  "document-template",
  "print-css",
  "exports",
] as const;

const DOCUMENT_MEDIA_SPEC: FrameworkAdapterSpec = {
  target: DOCUMENT_MEDIA_DESIGN_TARGET,
  capabilities: [...DOCUMENT_MEDIA_CAPABILITIES],
  componentExtension: "html",
  componentPrefix: "templates",
  tokenPath: "styles/document.css",
  tokenMediaType: "text/css",
  catalogPath: "catalog/components.json",
  exportFormats: ["pdf", "docx"],
  projectTokens(tokens) {
    const entries = Object.entries(tokens).map(([key, token]) => {
      const name = `--${key.replaceAll(".", "-")}`;
      return `  ${name}: ${token.$value};`;
    });
    return `@page { size: A4; margin: 2cm; }\n:root {\n${entries.join("\n")}\n}\n`;
  },
  buildCatalogComponents(surfaceCount) {
    return Array.from({ length: Math.max(1, surfaceCount) }, (_, index) => ({
      key: `template-${index + 1}`,
      primitive: "document-template",
      sourcePath: `templates/template-${index + 1}.html`,
    }));
  },
  componentHeader(key) {
    return [
      `<!-- document-media template stub '${key}' (Tanren ds-7). -->`,
      `<article data-template="${key}">`,
      "  <h1>Document title</h1>",
      "  <section>Body</section>",
      "</article>",
      "",
    ].join("\n");
  },
};

export class DocumentMediaDesignTargetAdapter extends FrameworkDesignTargetAdapter {
  constructor(tokens: Readonly<Record<string, unknown>>) {
    super(DOCUMENT_MEDIA_SPEC, tokens);
  }
}

export function buildDocumentMediaAdapter(tokens: Readonly<Record<string, unknown>>): DocumentMediaDesignTargetAdapter {
  return new DocumentMediaDesignTargetAdapter(tokens);
}
