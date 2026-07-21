// ds-7 — generic-web framework adapter. Projects the resolved DTCG token set
// onto framework-neutral CSS variables + plain DOM component stubs. Distinct
// from web-react (ds-2): no React, no shadcn, no Storybook — a framework-neutral
// projection for vanilla web / static sites.

import { FrameworkDesignTargetAdapter, type FrameworkAdapterSpec } from "./frameworkAdapterCore.js";

export const GENERIC_WEB_DESIGN_TARGET = "generic-web" as const;

const GENERIC_WEB_CAPABILITIES = ["tokens", "catalog", "components", "css-variables", "dom", "exports"] as const;

const GENERIC_WEB_SPEC: FrameworkAdapterSpec = {
  target: GENERIC_WEB_DESIGN_TARGET,
  capabilities: [...GENERIC_WEB_CAPABILITIES],
  componentExtension: "html",
  componentPrefix: "components",
  tokenPath: "styles/tokens.css",
  tokenMediaType: "text/css",
  catalogPath: "catalog/components.json",
  exportFormats: ["css", "html"],
  projectTokens(tokens) {
    const entries = Object.entries(tokens).map(([key, token]) => {
      const name = `--${key.replaceAll(".", "-")}`;
      return `  ${name}: ${token.$value};`;
    });
    return `:root {\n${entries.join("\n")}\n}\n`;
  },
  buildCatalogComponents(surfaceCount) {
    return Array.from({ length: Math.max(1, surfaceCount) }, (_, index) => ({
      key: `surface-${index + 1}`,
      primitive: "HTMLElement",
      sourcePath: `components/surface-${index + 1}.html`,
    }));
  },
  componentHeader(key) {
    return [
      `<!-- generic-web component stub '${key}' (Tanren ds-7). -->`,
      `<template data-component="${key}">`,
      "  <slot></slot>",
      "</template>",
      "",
    ].join("\n");
  },
};

export class GenericWebDesignTargetAdapter extends FrameworkDesignTargetAdapter {
  constructor(tokens: Readonly<Record<string, unknown>>) {
    super(GENERIC_WEB_SPEC, tokens);
  }
}

export function buildGenericWebAdapter(tokens: Readonly<Record<string, unknown>>): GenericWebDesignTargetAdapter {
  return new GenericWebDesignTargetAdapter(tokens);
}
