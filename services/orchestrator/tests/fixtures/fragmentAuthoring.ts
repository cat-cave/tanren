// Test-only deterministic fragment authorer (docs/roadmap/templating-system.md F2).
//
// `buildFakeFragmentAuthorer` produces a minimal Fragment-shaped body for any
// `FragmentSpec` — guaranteed to parse via `interpretOrgFragment` + smoke-compose
// for any spec the bundled library can satisfy with `node-pnpm` defaults. Test-
// only: the `fake` stem is in the `no-production-stubs` lint taxonomy, so any
// attempt to wire this builder as a production default is mechanically caught.
// Production wires the real LLM-backed `wrapProviderFragmentAuthorer`.

import type { FragmentAuthorer } from "../../src/engine/templates/index.js";

export function buildFakeFragmentAuthorer(): FragmentAuthorer {
  return async (input) => {
    const { spec } = input;
    const lines: string[] = [
      `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
      ``,
      `export const fragment: Fragment = {`,
      `  id: "${spec.id}",`,
      `  version: "1.0.0",`,
      `  kind: "${spec.kind}",`,
      `  contract: ${JSON.stringify(spec.requiredContract)},`,
      `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
      // Author a minimal marker file the fragment owns.
      `    vfs.write("docs/${spec.id}.md", "Tanren ${spec.id} fragment\\n");`,
      `  },`,
      `};`,
      `export default fragment;`,
    ];
    return { bodyTs: lines.join("\n") };
  };
}
