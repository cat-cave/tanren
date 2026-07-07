// FRAGMENT-LIBRARY REGISTRY (the bundled core fragment catalog —
// docs/roadmap/templating-system.md §1).
//
// `loadFragmentLibrary` returns the production registry; `loadFragmentLibraryForTests`
// is the unit-test seam that ALSO accepts an `extra` array of fragments to register
// (used by the dogfood test to inject a deliberately-non-compliant fragment that the
// composer must reject).

import { addonBiomeFragment } from "./addon-biome.js";
import { addonDockerFragment } from "./addon-docker.js";
import { baseFragment } from "./base.js";
import { dbPostgresPrismaFragment } from "./db-postgres-prisma.js";
import { deployFlyFragment } from "./deploy-fly.js";
import { deployNoneFragment } from "./deploy-none.js";
import { frontendReactRouterFragment } from "./frontend-react-router.js";
import { frontendRemixFragment } from "./frontend-remix.js";
import { runtimeNodePnpmFragment } from "./runtime-node-pnpm.js";
import { runtimeRubyBundlerFragment } from "./runtime-ruby-bundler.js";
import { type Fragment, FragmentLibrary } from "../types.js";

const ALL_FRAGMENTS: readonly Fragment[] = [
  baseFragment,
  runtimeNodePnpmFragment,
  runtimeRubyBundlerFragment,
  frontendReactRouterFragment,
  frontendRemixFragment,
  dbPostgresPrismaFragment,
  deployFlyFragment,
  deployNoneFragment,
  addonBiomeFragment,
  addonDockerFragment,
];

/**
 * The production fragment registry. Every fragment shipped with this PR is registered
 * here; future fragments add a `register` call.
 */
export function loadFragmentLibrary(): FragmentLibrary {
  const library = new FragmentLibrary();
  for (const fragment of ALL_FRAGMENTS) library.register(fragment);
  return library;
}

/**
 * Test seam — the production registry plus a caller-supplied `extra` list. The
 * dogfood test uses this to register a deliberately non-compliant fragment and
 * assert the composer rejects it.
 */
export function loadFragmentLibraryForTests(extra?: readonly Fragment[]): FragmentLibrary {
  const library = loadFragmentLibrary();
  for (const fragment of extra ?? []) library.register(fragment);
  return library;
}

export { ADDON_BIOME_ID } from "./addon-biome.js";
export { ADDON_DOCKER_ID } from "./addon-docker.js";
export { BASE_FRAGMENT_ID, BASE_FRAGMENT_VERSION, BASE_JUSTFILE_TARGETS, BASE_PROTECTED_FILES } from "./base.js";
export { RUNTIME_NODE_PNPM_ID } from "./runtime-node-pnpm.js";
export { RUNTIME_RUBY_BUNDLER_ID } from "./runtime-ruby-bundler.js";
export { FRONTEND_REACT_ROUTER_ID } from "./frontend-react-router.js";
export { FRONTEND_REMIX_ID } from "./frontend-remix.js";
export { DB_POSTGRES_PRISMA_ID } from "./db-postgres-prisma.js";
export { DEPLOY_FLY_ID } from "./deploy-fly.js";
export { DEPLOY_NONE_ID } from "./deploy-none.js";
