// ds-7 — Jetpack Compose (Android) framework adapter. Projects the resolved
// DTCG token set onto Kotlin object color constants + Composable stubs.

import { FrameworkDesignTargetAdapter, type FrameworkAdapterSpec } from "./frameworkAdapterCore.js";

export const JETPACK_COMPOSE_DESIGN_TARGET = "jetpack-compose" as const;

const JETPACK_COMPOSE_CAPABILITIES = [
  "tokens",
  "catalog",
  "components",
  "compose-ui",
  "compose-material",
  "gradle",
] as const;

const JETPACK_COMPOSE_SPEC: FrameworkAdapterSpec = {
  target: JETPACK_COMPOSE_DESIGN_TARGET,
  capabilities: [...JETPACK_COMPOSE_CAPABILITIES],
  componentExtension: "kt",
  componentPrefix: "app/src/main/java/tanren/design/ui",
  tokenPath: "app/src/main/java/tanren/design/Tokens.kt",
  tokenMediaType: "text/plain",
  catalogPath: "catalog/components.json",
  exportFormats: ["gradle", "compose-material"],
  projectTokens(tokens) {
    const entries = Object.entries(tokens).map(([key, token]) => {
      const name = key
        .split(".")
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join("");
      return `val ${name}: Color = Color(${kotlinColorLong(token.$value)})`;
    });
    return [
      "// Jetpack Compose token projection (Tanren ds-7).",
      "package tanren.design",
      "import androidx.compose.ui.graphics.Color",
      "object Tokens {",
      ...entries,
      "}",
      "",
    ].join("\n");
  },
  buildCatalogComponents(surfaceCount) {
    return Array.from({ length: Math.max(1, surfaceCount) }, (_, index) => ({
      key: `Surface${index + 1}`,
      primitive: "androidx.compose.runtime.Composable",
      sourcePath: `app/src/main/java/tanren/design/ui/Surface${index + 1}.kt`,
    }));
  },
  componentHeader(key) {
    return [
      `// Jetpack Compose component stub '${key}' (Tanren ds-7).`,
      "package tanren.design.ui",
      "import androidx.compose.runtime.Composable",
      "",
      "@Composable",
      `fun ${key}() {`,
      "    // empty surface",
      "}",
      "",
    ].join("\n");
  },
};

export class JetpackComposeDesignTargetAdapter extends FrameworkDesignTargetAdapter {
  constructor(tokens: Readonly<Record<string, unknown>>) {
    super(JETPACK_COMPOSE_SPEC, tokens);
  }
}

export function buildJetpackComposeAdapter(
  tokens: Readonly<Record<string, unknown>>,
): JetpackComposeDesignTargetAdapter {
  return new JetpackComposeDesignTargetAdapter(tokens);
}

/** Convert a hex color (#rrggbb) into Kotlin `Color(0xFFRRGGBB.toLong())`. */
function kotlinColorLong(value: string): string {
  const hex = value.replace("#", "");
  if (hex.length !== 6) return "0xFF000000";
  return `0xFF${hex.toUpperCase()}`;
}
