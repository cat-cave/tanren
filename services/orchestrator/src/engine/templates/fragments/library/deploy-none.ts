// DEPLOY — none. The explicit no-deploy marker (an absent `deploy` field would be
// ambiguous; `deploy: "none"` is the named "no deploy target" config). Adds a stub
// `deploy.md` documenting the choice — no fly.toml, no vercel.json, no env vars.

import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const DEPLOY_NONE_ID = "deploy-none" as const;

const DEPLOY_DOC = `# Deploy: none

This template was composed with \`deploy: "none"\` — no deploy target is wired. To
add one later, recompose the template with a real deploy point (\`fly\`, \`vercel\`)
or implement the project's own \`just build\`/\`just deploy\` recipe.
`;

export const deployNoneFragment: Fragment = {
  id: DEPLOY_NONE_ID,
  version: "1.0.0",
  kind: "deploy",
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("docs/deploy.md", DEPLOY_DOC);
  },
};
