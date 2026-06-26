// DEPLOY — Fly.io. Adds the fly.toml + a deploy README section.

import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const DEPLOY_FLY_ID = "deploy-fly" as const;

const FLY_TOML = `# Tanren fly.io — fill app name + region per environment. The deploy command runs
# via the project's \`just build\` (the ci.yml's deploy.run); fly deploy targets are
# resolved by Tanren's deploy-target-resolution from the org's integration grants.
app = "TANREN_APP_NAME"
primary_region = "iad"

[build]
  builder = "paketobuildpacks/builder:base"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
`;

export const deployFlyFragment: Fragment = {
  id: DEPLOY_FLY_ID,
  version: "1.0.0",
  kind: "deploy",
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("fly.toml", FLY_TOML);
    vfs.addEnvVar("FLY_API_TOKEN", "fly_token_provisioned_via_tanren_integration_grant");
  },
};
