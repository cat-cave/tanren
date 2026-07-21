// ds-7 — Flutter (Dart) framework adapter. Projects the resolved DTCG token
// set onto Dart Color constants + Widget stubs.

import { FrameworkDesignTargetAdapter, type FrameworkAdapterSpec } from "./frameworkAdapterCore.js";

export const FLUTTER_DESIGN_TARGET = "flutter" as const;

const FLUTTER_CAPABILITIES = [
  "tokens",
  "catalog",
  "components",
  "flutter-widget",
  "flutter-material",
  "pubspec",
] as const;

const FLUTTER_SPEC: FrameworkAdapterSpec = {
  target: FLUTTER_DESIGN_TARGET,
  capabilities: [...FLUTTER_CAPABILITIES],
  componentExtension: "dart",
  componentPrefix: "lib/design/ui",
  tokenPath: "lib/design/tokens.dart",
  tokenMediaType: "text/plain",
  catalogPath: "catalog/components.json",
  exportFormats: ["pubspec", "flutter-material"],
  projectTokens(tokens) {
    const entries = Object.entries(tokens).map(([key, token]) => {
      const name = key
        .split(".")
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join("");
      return `static const Color ${name} = Color(${dartColorLong(token.$value)});`;
    });
    return [
      "// Flutter token projection (Tanren ds-7).",
      "import 'package:flutter/painting.dart';",
      "abstract final class DesignTokens {",
      ...entries,
      "}",
      "",
    ].join("\n");
  },
  buildCatalogComponents(surfaceCount) {
    return Array.from({ length: Math.max(1, surfaceCount) }, (_, index) => ({
      key: `Surface${index + 1}`,
      primitive: "StatelessWidget",
      sourcePath: `lib/design/ui/surface_${index + 1}.dart`,
    }));
  },
  componentHeader(key) {
    return [
      `// Flutter component stub '${key}' (Tanren ds-7).`,
      "import 'package:flutter/widgets.dart';",
      "",
      `class ${key} extends StatelessWidget {`,
      "  const ${key}({super.key});",
      "  @override",
      "  Widget build(BuildContext context) => const SizedBox.shrink();",
      "}",
      "",
    ].join("\n");
  },
};

export class FlutterDesignTargetAdapter extends FrameworkDesignTargetAdapter {
  constructor(tokens: Readonly<Record<string, unknown>>) {
    super(FLUTTER_SPEC, tokens);
  }
}

export function buildFlutterAdapter(tokens: Readonly<Record<string, unknown>>): FlutterDesignTargetAdapter {
  return new FlutterDesignTargetAdapter(tokens);
}

/** Convert a hex color (#rrggbb) into Dart `0xFFRRGGBB`. */
function dartColorLong(value: string): string {
  const hex = value.replace("#", "");
  if (hex.length !== 6) return "0xFF000000";
  return `0xFF${hex.toUpperCase()}`;
}
