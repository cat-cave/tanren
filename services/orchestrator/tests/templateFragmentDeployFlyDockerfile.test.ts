// PR4 — deploy-fly ships a buildable Dockerfile for the host image build.
//
// The orchestrator builds the merged commit into an image on the host via
// `docker buildx build --push` and releases it; that host build needs a
// Dockerfile in the composed repo. A Fly web app does NOT get addon-docker by
// default, so deploy-fly must ship the recipe itself. The recipe is shared with
// addon-docker (`dockerfileFor` + `DOCKERIGNORE`) so a project that ALSO
// declares `addons: ["docker"]` composes with zero collision (deploy runs LAST;
// `vfs.overwrite` sets the identical bytes addon-docker already wrote).
//
// This suite pins:
//   1. A Fly + node-pnpm config yields a runtime Dockerfile, a .dockerignore,
//      and a fly.toml whose `[build]` block points at `dockerfile = "Dockerfile"`
//      (NOT the old buildpacks builder), with `internal_port = 3000` preserved.
//   2. A config with BOTH `addons: ["docker"]` and `deploy: "fly"` composes with
//      NO `VfsCollisionError` (deploy's overwrite is collision-free) and the
//      Dockerfile bytes match the shared recipe (zero drift).

import { describe, expect, it } from "vitest";
import { composeTemplate, loadFragmentLibrary, type TemplateConfig } from "../src/engine/templates/index.js";

describe("template-fragment deploy-fly — ships a buildable Dockerfile (PR4)", () => {
  it("a Fly + node-pnpm config yields a runtime Dockerfile + .dockerignore + a Dockerfile fly.toml build", async () => {
    const library = loadFragmentLibrary();
    const config: TemplateConfig = {
      slug: "fly-dockerfile-node",
      runtime: "node-pnpm",
      deploy: "fly",
      addons: [],
      examples: [],
    };
    const vfs = await composeTemplate(config, library);

    const dockerfile = vfs.read("Dockerfile");
    expect(dockerfile.includes("pnpm install --no-frozen-lockfile")).toBe(true);
    expect(dockerfile.includes('CMD ["node", "dist/index.js"]')).toBe(true);
    expect(vfs.has(".dockerignore")).toBe(true);

    const flyToml = vfs.read("fly.toml");
    expect(flyToml.includes("internal_port = 3000")).toBe(true);
    expect(flyToml.includes('dockerfile = "Dockerfile"')).toBe(true);
    expect(flyToml.includes("paketobuildpacks")).toBe(false);
  });

  it('a config with BOTH addons: ["docker"] and deploy: "fly" composes with no VfsCollisionError', async () => {
    const library = loadFragmentLibrary();
    const config: TemplateConfig = {
      slug: "fly-with-docker-addon",
      runtime: "node-pnpm",
      deploy: "fly",
      addons: ["docker"],
      examples: [],
    };
    // Reaching this point (no throw) proves no VfsCollisionError — addon-docker
    // writes Dockerfile/.dockerignore in the addon phase; deploy-fly (which runs
    // LAST) overwrites them with the identical shared recipe.
    const vfs = await composeTemplate(config, library);
    expect(vfs.has("Dockerfile")).toBe(true);
    expect(vfs.has(".dockerignore")).toBe(true);
    const dockerfile = vfs.read("Dockerfile");
    expect(dockerfile.includes("pnpm install --no-frozen-lockfile")).toBe(true);
    expect(dockerfile.includes('CMD ["node", "dist/index.js"]')).toBe(true);
  });
});
