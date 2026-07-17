// ds-2 — shadcn/Radix catalog manifest and source projection for web artifacts.

import type { WebArtifactSourceFile } from "./webFiles.js";
import type { WebTokenBinding } from "./webTokens.js";

export const WEB_CATALOG_SCHEMA_VERSION = 1 as const;

export interface WebCatalogComponent {
  readonly key: string;
  readonly primitive: string;
  readonly packageName: string;
  readonly sourcePath: string;
  readonly tokenBindings: Readonly<Record<string, string>>;
}

export interface WebComponentCatalog {
  readonly schemaVersion: typeof WEB_CATALOG_SCHEMA_VERSION;
  readonly framework: "react";
  readonly style: "shadcn";
  readonly components: readonly WebCatalogComponent[];
}

export interface WebCatalogProjection {
  readonly catalog: WebComponentCatalog;
  readonly files: readonly WebArtifactSourceFile[];
}

interface CatalogBindings {
  readonly background: string;
  readonly foreground: string;
  readonly primary: string;
  readonly muted: string;
  readonly border: string;
  readonly radius: string;
  readonly spacing: string;
}

/** Build a Storybook-compatible catalog over the adapter's resolved token binding names. */
export function projectWebCatalog(tokens: readonly WebTokenBinding[]): WebCatalogProjection {
  const bindings = catalogBindings(tokens);
  const components = catalogComponents(bindings);
  const catalog: WebComponentCatalog = {
    schemaVersion: WEB_CATALOG_SCHEMA_VERSION,
    framework: "react",
    style: "shadcn",
    components,
  };
  return {
    catalog,
    files: [
      {
        path: "components.json",
        kind: "component-contract",
        mediaType: "application/json",
        source: `${JSON.stringify(shadcnComponentsConfig(), null, 2)}\n`,
      },
      {
        path: "catalog/components.json",
        kind: "catalog",
        mediaType: "application/json",
        source: `${JSON.stringify(catalog, null, 2)}\n`,
      },
      ...componentSourceFiles(),
      {
        path: "catalog/components.stories.tsx",
        kind: "catalog",
        mediaType: "text/plain",
        source: storySource(components),
      },
    ],
  };
}

function catalogBindings(tokens: readonly WebTokenBinding[]): CatalogBindings {
  const color = (role: string): string => selectToken(tokens, "color", role).cssVariable;
  const dimension = (role: string): string => selectToken(tokens, "dimension", role).cssVariable;
  return {
    background: color("background"),
    foreground: color("foreground"),
    primary: color("primary"),
    muted: color("muted"),
    border: color("border"),
    radius: dimension("radius"),
    spacing: dimension("space"),
  };
}

function selectToken(tokens: readonly WebTokenBinding[], type: string, role: string): WebTokenBinding {
  const typed = tokens.filter((token) => token.type === type);
  const matched = typed.find((token) => token.path.split(".").some((part) => part.toLowerCase().includes(role)));
  const fallback = typed[0];
  if (matched !== undefined) return matched;
  if (fallback !== undefined) return fallback;
  throw new Error(`web catalog requires a '${type}' token for '${role}'`);
}

function catalogComponents(bindings: CatalogBindings): WebCatalogComponent[] {
  const common = {
    background: bindings.background,
    foreground: bindings.foreground,
    border: bindings.border,
    radius: bindings.radius,
    spacing: bindings.spacing,
  };
  return [
    {
      key: "button",
      primitive: "@radix-ui/react-slot",
      packageName: "@radix-ui/react-slot",
      sourcePath: "components/ui/button.tsx",
      tokenBindings: { ...common, background: bindings.primary },
    },
    {
      key: "dialog",
      primitive: "@radix-ui/react-dialog",
      packageName: "@radix-ui/react-dialog",
      sourcePath: "components/ui/dialog.tsx",
      tokenBindings: common,
    },
    {
      key: "dropdown-menu",
      primitive: "@radix-ui/react-dropdown-menu",
      packageName: "@radix-ui/react-dropdown-menu",
      sourcePath: "components/ui/dropdown-menu.tsx",
      tokenBindings: common,
    },
    {
      key: "tabs",
      primitive: "@radix-ui/react-tabs",
      packageName: "@radix-ui/react-tabs",
      sourcePath: "components/ui/tabs.tsx",
      tokenBindings: { ...common, background: bindings.muted },
    },
    {
      key: "tooltip",
      primitive: "@radix-ui/react-tooltip",
      packageName: "@radix-ui/react-tooltip",
      sourcePath: "components/ui/tooltip.tsx",
      tokenBindings: { ...common, background: bindings.foreground, foreground: bindings.background },
    },
  ];
}

function shadcnComponentsConfig(): Record<string, unknown> {
  return {
    $schema: "https://ui.shadcn.com/schema.json",
    style: "new-york",
    rsc: false,
    tsx: true,
    tailwind: { config: "tailwind.config.ts", css: "styles/tokens.css", baseColor: "slate", cssVariables: true },
    aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui" },
  };
}

function componentSourceFiles(): WebArtifactSourceFile[] {
  return [
    componentSource(
      "button",
      'import * as React from "react";\nimport { Slot } from "@radix-ui/react-slot";\n\nexport interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { asChild?: boolean; }\n\nexport const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ asChild = false, ...props }, ref) => {\n  const Comp = asChild ? Slot : "button";\n  return <Comp ref={ref} {...props} />;\n});\nButton.displayName = "Button";\n',
    ),
    componentSource("dialog", radixComponent("Dialog", "@radix-ui/react-dialog")),
    componentSource("dropdown-menu", radixComponent("DropdownMenu", "@radix-ui/react-dropdown-menu")),
    componentSource("tabs", radixComponent("Tabs", "@radix-ui/react-tabs")),
    componentSource("tooltip", radixComponent("Tooltip", "@radix-ui/react-tooltip")),
  ];
}

function componentSource(key: string, source: string): WebArtifactSourceFile {
  return { path: `components/ui/${key}.tsx`, kind: "component-source", mediaType: "text/plain", source };
}

function radixComponent(name: string, packageName: string): string {
  return [
    `import * as ${name}Primitive from "${packageName}";`,
    "",
    `export const ${name} = ${name}Primitive.Root;`,
    `export const ${name}Trigger = ${name}Primitive.Trigger;`,
    `export const ${name}Content = ${name}Primitive.Content;`,
    "",
  ].join("\n");
}

function storySource(components: readonly WebCatalogComponent[]): string {
  return [
    "// Storybook-compatible catalog index generated by Tanren.",
    "export const webDesignComponents = [",
    ...components.map((catalogComponent) => `  ${JSON.stringify(catalogComponent)},`),
    "] as const;",
    "",
  ].join("\n");
}
