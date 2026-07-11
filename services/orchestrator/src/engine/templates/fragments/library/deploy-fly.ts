// DEPLOY — Fly.io. Adds the fly.toml (a Dockerfile build, not buildpacks) +
// FLY_API_TOKEN env var, AND ships a runtime-aware Dockerfile + .dockerignore
// for the host image build. The orchestrator builds the merged commit into an
// image on the host via `docker buildx build --push` and releases it; that host
// build needs a Dockerfile in the composed repo. A Fly web app does NOT get
// `addon-docker` by default, so this fragment ships the recipe itself. The
// Dockerfile content is shared with `addon-docker.ts` (`dockerfileFor` +
// `DOCKERIGNORE`) so a project that ALSO declares `addons: ["docker"]` composes
// with zero collision (deploy runs LAST; a `has`-guarded write skips when a
// Dockerfile already exists — addon-docker's identical one, or an org-custom one
// which is PRESERVED, never clobbered) and zero drift.

import { dockerfileFor, DOCKERIGNORE } from "./addon-docker.js";
import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const DEPLOY_FLY_ID = "deploy-fly" as const;

const FLY_TOML = `# Tanren fly.io — fill app name + region per environment. The deploy command runs
# via the project's \`just build\` (the ci.yml's deploy.run); fly deploy targets are
# resolved by Tanren's deploy-target-resolution from the org's integration grants.
app = "TANREN_APP_NAME"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

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
  async apply(vfs: VirtualFileSystem, config: TemplateConfig): Promise<void> {
    vfs.write("fly.toml", FLY_TOML);
    // The deploy phase runs LAST (after addons). ENSURE-A-RECIPE, don't clobber: write the
    // host-build Dockerfile only if none exists yet. When `addon-docker` already wrote one
    // (built-ins are byte-identical), or an org-shadowed fragment supplied a CUSTOM one,
    // this preserves it; when nothing did, this guarantees the recipe exists so the
    // merge-reflecting host build has something to `docker build`. (A guarded write, not
    // `overwrite`, so a custom Dockerfile is never silently replaced.)
    if (!vfs.has("Dockerfile")) {
      vfs.write("Dockerfile", dockerfileFor(config.runtime));
    }
    if (!vfs.has(".dockerignore")) {
      vfs.write(".dockerignore", DOCKERIGNORE);
    }
    vfs.addEnvVar("FLY_API_TOKEN", "fly_token_provisioned_via_tanren_integration_grant");
  },
};
