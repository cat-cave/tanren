// ds-7 — SwiftUI (iOS / macOS) framework adapter. Projects the resolved DTCG
// token set onto Swift color assets + SwiftUI View component stubs.

import { FrameworkDesignTargetAdapter, type FrameworkAdapterSpec } from "./frameworkAdapterCore.js";

export const SWIFTUI_DESIGN_TARGET = "swiftui" as const;

const SWIFTUI_CAPABILITIES = ["tokens", "catalog", "components", "swiftui-view", "asset-catalog", "xcode"] as const;

const SWIFTUI_SPEC: FrameworkAdapterSpec = {
  target: SWIFTUI_DESIGN_TARGET,
  capabilities: [...SWIFTUI_CAPABILITIES],
  componentExtension: "swift",
  componentPrefix: "Sources/UI",
  tokenPath: "Sources/Tokens.swift",
  tokenMediaType: "text/plain",
  catalogPath: "catalog/components.json",
  exportFormats: ["xcode", "asset-catalog"],
  projectTokens(tokens) {
    const entries = Object.entries(tokens).map(([key, token]) => {
      const name = key
        .split(".")
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join("");
      return `public extension Color where Self: Sendable { static let ${name} = Color(red: ${swiftRgb(token.$value)}) }`;
    });
    return `// SwiftUI token projection (Tanren ds-7).\nimport SwiftUI\n${entries.join("\n")}\n`;
  },
  buildCatalogComponents(surfaceCount) {
    return Array.from({ length: Math.max(1, surfaceCount) }, (_, index) => ({
      key: `Surface${index + 1}`,
      primitive: "SwiftUI.View",
      sourcePath: `Sources/ui/Surface${index + 1}.swift`,
    }));
  },
  componentHeader(key) {
    return [
      `// SwiftUI component stub '${key}' (Tanren ds-7).`,
      "import SwiftUI",
      "",
      `public struct ${key}: View {`,
      "    public init() {}",
      "    public var body: some View { EmptyView() }",
      "}",
      "",
    ].join("\n");
  },
};

export class SwiftUIFrameworkDesignTargetAdapter extends FrameworkDesignTargetAdapter {
  constructor(tokens: Readonly<Record<string, unknown>>) {
    super(SWIFTUI_SPEC, tokens);
  }
}

export function buildSwiftUiAdapter(tokens: Readonly<Record<string, unknown>>): SwiftUIFrameworkDesignTargetAdapter {
  return new SwiftUIFrameworkDesignTargetAdapter(tokens);
}

/** Convert a hex color (#rrggbb) into SwiftUI RGB components (0…1). */
function swiftRgb(value: string): string {
  const hex = value.replace("#", "");
  if (hex.length !== 6) return "0.0, 0.0, 0.0";
  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
  return `${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}`;
}
