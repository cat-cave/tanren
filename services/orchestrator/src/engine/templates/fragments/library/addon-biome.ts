// ADDON — biome (the formatter/linter). A node-pnpm runtime addon; depends on the
// node-pnpm runtime so a ruby + biome config is rejected at dependency resolve.

import { RUNTIME_NODE_PNPM_ID } from "./runtime-node-pnpm.js";
import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const ADDON_BIOME_ID = "addon-biome" as const;

const BIOME_CONFIG = `{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": {
    "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts"]
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": { "enabled": true, "rules": { "recommended": true } }
}
`;

export const addonBiomeFragment: Fragment = {
  id: ADDON_BIOME_ID,
  version: "1.0.0",
  kind: "addon",
  dependsOn: [RUNTIME_NODE_PNPM_ID],
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("biome.json", BIOME_CONFIG);
    vfs.addPackageJsonDevDep("@biomejs/biome", "^2.0.0");
  },
};
