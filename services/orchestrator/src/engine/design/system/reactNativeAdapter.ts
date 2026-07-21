// ds-7 — React Native framework adapter. Projects the resolved DTCG token set
// onto RN TS style constants + React Native component stubs.

import { FrameworkDesignTargetAdapter, type FrameworkAdapterSpec } from "./frameworkAdapterCore.js";

export const REACT_NATIVE_DESIGN_TARGET = "react-native" as const;

const REACT_NATIVE_CAPABILITIES = [
  "tokens",
  "catalog",
  "components",
  "react-native-components",
  "react-native-style-sheet",
  "expo",
] as const;

const REACT_NATIVE_SPEC: FrameworkAdapterSpec = {
  target: REACT_NATIVE_DESIGN_TARGET,
  capabilities: [...REACT_NATIVE_CAPABILITIES],
  componentExtension: "tsx",
  componentPrefix: "src/design/ui",
  tokenPath: "src/design/tokens.ts",
  tokenMediaType: "text/plain",
  catalogPath: "catalog/components.json",
  exportFormats: ["expo", "react-native-style-sheet"],
  projectTokens(tokens) {
    const entries = Object.entries(tokens).map(([key, token]) => {
      const path = key.replaceAll(".", "_").replaceAll("-", "_");
      return `export const ${path}: string = ${JSON.stringify(token.$value)};`;
    });
    return ["// React Native token projection (Tanren ds-7).", ...entries, ""].join("\n");
  },
  buildCatalogComponents(surfaceCount) {
    return Array.from({ length: Math.max(1, surfaceCount) }, (_, index) => ({
      key: `Surface${index + 1}`,
      primitive: "react-native.View",
      sourcePath: `src/design/ui/Surface${index + 1}.tsx`,
    }));
  },
  componentHeader(key) {
    return [
      `// React Native component stub '${key}' (Tanren ds-7).`,
      'import { View } from "react-native";',
      "",
      `export function ${key}(): JSX.Element {`,
      "  return <View />;",
      "}",
      "",
    ].join("\n");
  },
};

export class ReactNativeDesignTargetAdapter extends FrameworkDesignTargetAdapter {
  constructor(tokens: Readonly<Record<string, unknown>>) {
    super(REACT_NATIVE_SPEC, tokens);
  }
}

export function buildReactNativeAdapter(tokens: Readonly<Record<string, unknown>>): ReactNativeDesignTargetAdapter {
  return new ReactNativeDesignTargetAdapter(tokens);
}
