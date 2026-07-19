// ds-4 sub-node #1 — browser-free React SSR of a real catalog component.
//
// The catalog components (`webCatalog`) are REAL React TSX source strings that
// import `react` + `@radix-ui/react-*`. We bundle that source with esbuild
// (transforming TSX, inlining radix) and evaluate it to obtain the real
// component, then render it with THIS process's `react-dom/server`
// `renderToStaticMarkup`. `react` / `react/jsx-runtime` are marked external so
// the bundled component and the harness share ONE react instance (element
// symbols stay identity-equal — no cross-realm element rejection).

import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import esbuild, { type Plugin } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const nodeRequire = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const VIRTUAL_COMPONENT = "virtual:catalog-component";
/** react family is external → single shared instance; everything else is bundled. */
const EXTERNAL_REACT = ["react", "react-dom", "react-dom/server", "react/jsx-runtime", "react/jsx-dev-runtime"];

export interface SsrRenderInput {
  readonly componentSource: string;
  readonly componentExportName: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children?: string;
}

export type SsrRenderResult =
  | { readonly ok: true; readonly html: string }
  | { readonly ok: false; readonly stage: "bundle" | "render"; readonly reason: string };

function virtualComponentPlugin(source: string): Plugin {
  return {
    name: "virtual-catalog-component",
    setup(build) {
      // esbuild filters compile to Go's RE2 — the `u` flag is unsupported there
      // (a `u`-flagged JS regex makes esbuild prepend `(?u)`, which RE2 rejects).
      // eslint-disable-next-line require-unicode-regexp
      build.onResolve({ filter: /^virtual:catalog-component$/ }, () => ({
        path: VIRTUAL_COMPONENT,
        namespace: "virtual-catalog",
      }));
      // eslint-disable-next-line require-unicode-regexp
      build.onLoad({ filter: /.*/, namespace: "virtual-catalog" }, () => ({
        contents: source,
        loader: "tsx",
        resolveDir: HERE,
      }));
    },
  };
}

/**
 * Bundle + evaluate the catalog component source, returning the real component
 * constructor. A compile/bundle error (missing import, syntax) surfaces as a
 * typed bundle failure — never a blank component.
 */
async function loadComponent(
  input: SsrRenderInput,
): Promise<{ readonly ok: true; readonly component: unknown } | { readonly ok: false; readonly reason: string }> {
  const entry = [
    `import { ${input.componentExportName} as RenderTarget } from "${VIRTUAL_COMPONENT}";`,
    "export const renderTarget = RenderTarget;",
    "",
  ].join("\n");
  let code: string;
  try {
    const built = await esbuild.build({
      stdin: { contents: entry, loader: "ts", resolveDir: HERE, sourcefile: "render-entry.ts" },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      jsx: "automatic",
      logLevel: "silent",
      external: EXTERNAL_REACT,
      plugins: [virtualComponentPlugin(input.componentSource)],
    });
    const [output] = built.outputFiles;
    if (output === undefined) return { ok: false, reason: "esbuild produced no output" };
    code = output.text;
  } catch (error) {
    return { ok: false, reason: `bundle failed: ${describe(error)}` };
  }
  try {
    const evaluated: { exports: Record<string, unknown> } = { exports: {} };
    // `vm.compileFunction` (not `new Function`) so the bundled CJS runs with an
    // explicit (module, exports, require) frame — react/jsx-runtime are external
    // and resolve through `nodeRequire` to THIS process's single react instance.
    const evaluate = compileFunction(code, ["module", "exports", "require"], {
      filename: "catalog-component.cjs",
    }) as (
      module: { exports: Record<string, unknown> },
      exports: Record<string, unknown>,
      require: NodeRequire,
    ) => void;
    evaluate(evaluated, evaluated.exports, nodeRequire);
    const component = evaluated.exports["renderTarget"];
    if (component === undefined || component === null) {
      return { ok: false, reason: `export '${input.componentExportName}' is missing from the bundled component` };
    }
    return { ok: true, component };
  } catch (error) {
    return { ok: false, reason: `evaluate failed: ${describe(error)}` };
  }
}

/**
 * Render the real catalog component to static HTML via `react-dom/server`. A
 * bundle/compile problem → `stage: "bundle"`; a render throw → `stage: "render"`.
 * The empty-render guard lives one layer up (the harness), so a component that
 * renders to nothing is caught as a fail-closed `empty_render`.
 */
export async function renderComponentToStaticMarkup(input: SsrRenderInput): Promise<SsrRenderResult> {
  const loaded = await loadComponent(input);
  if (!loaded.ok) return { ok: false, stage: "bundle", reason: loaded.reason };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bundled component is opaque to tsc.
    const element = createElement(loaded.component as any, { ...input.props }, input.children);
    const html = renderToStaticMarkup(element);
    return { ok: true, html };
  } catch (error) {
    return { ok: false, stage: "render", reason: `render failed: ${describe(error)}` };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
