// ds-7 — Bevy (Rust) framework adapter. Projects the resolved DTCG token set
// onto Rust constants + a minimal Bevy UI component catalog. REAL but small.
// The native cargo build/export verification is the receipt's job (the adapter
// never claims build success it did not observe).

import { FrameworkDesignTargetAdapter, type FrameworkAdapterSpec } from "./frameworkAdapterCore.js";

export const BEVY_DESIGN_TARGET = "bevy" as const;

const BEVY_CAPABILITIES = ["tokens", "catalog", "components", "bevy-ui", "bevy-asset", "cargo"] as const;

const BEVY_SPEC: FrameworkAdapterSpec = {
  target: BEVY_DESIGN_TARGET,
  capabilities: [...BEVY_CAPABILITIES],
  componentExtension: "rs",
  componentPrefix: "src/ui",
  tokenPath: "src/tokens.rs",
  tokenMediaType: "text/plain",
  catalogPath: "catalog/components.json",
  exportFormats: ["cargo", "bevy-asset"],
  projectTokens(tokens) {
    const entries = Object.entries(tokens).map(([key, token]) => {
      const path = key.replaceAll(".", "_").replaceAll("-", "_");
      return `pub const ${path}: &str = ${JSON.stringify(token.$value)};`;
    });
    return `// Bevy token projection (Tanren ds-7).\n${entries.join("\n")}\n`;
  },
  buildCatalogComponents(surfaceCount) {
    return Array.from({ length: Math.max(1, surfaceCount) }, (_, index) => ({
      key: `surface_${index + 1}`,
      primitive: "bevy_ui::node::NodeBundle",
      sourcePath: `src/ui/surface_${index + 1}.rs`,
    }));
  },
  componentHeader(key) {
    return [
      `// Bevy component stub '${key}' (Tanren ds-7).`,
      "use bevy_ui::prelude::*;",
      "",
      `pub fn ${key}_bundle() -> NodeBundle {`,
      "    NodeBundle::default()",
      "}",
      "",
    ].join("\n");
  },
};

export class BevyDesignTargetAdapter extends FrameworkDesignTargetAdapter {
  constructor(tokens: Readonly<Record<string, unknown>>) {
    super(BEVY_SPEC, tokens);
  }
}

export function buildBevyAdapter(tokens: Readonly<Record<string, unknown>>): BevyDesignTargetAdapter {
  return new BevyDesignTargetAdapter(tokens);
}
