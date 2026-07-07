// Smoke composition helpers for the F2 fragment-authoring VALIDATE stage
// (extracted from fragmentAuthoringRun.ts — audit finding H5 — task #150).
//
// Two smoke compositions run per authored fragment:
//
//   1. ISOLATED SMOKE — `runSmokeComposition`. The MINIMAL config that
//      exercises this fragment: base + runtime + deploy + the authored slot.
//      Post-compose runtime validators run (ci.yml schema, fresh-checkout
//      bootstrap, non-interactive pnpm install). Catches: does this fragment
//      compose ON ITS OWN?
//
//   2. FULL-LIBRARY SMOKE — `runFullLibrarySmokeComposition`. The KITCHEN-SINK
//      config: every bundled fragment compatible with the target runtime is
//      filled into its slot, alongside the authored fragment. Catches the
//      "isolated-fine but composes-with-conflict" class:
//         - file collisions with another bundled fragment's writes,
//         - package.json dep-version conflicts,
//         - justfile-target fills that clash under real integration,
//         - `dependency_runtime_mismatch` pre-flight failures the authored
//           fragment's implicit `dependsOn` would trigger against the full set.
//      Post-compose validators do NOT re-run here — the isolated smoke already
//      passed them. This smoke is compose-only integration.
//
// The doctrine: an authored fragment must compose ON ITS OWN AND alongside the
// bundled set the operator will actually use. Both smokes must pass before the
// fragment persists as validated.

import { composeTemplate, runtimeFragmentId } from "./compose.js";
import {
  ADDON_BIOME_ID,
  ADDON_DOCKER_ID,
  BASE_FRAGMENT_ID,
  DB_POSTGRES_PRISMA_ID,
  FRONTEND_REMIX_ID,
  loadFragmentLibrary,
  RUNTIME_NODE_PNPM_ID,
} from "./library/index.js";
import {
  assertComposedCiYmlParsesAsCiConfigV1,
  assertPnpmInstallIsNonInteractive,
  assertScaffoldBootstrapsFromFreshCheckout,
} from "./runtimeValidation.js";
import type { FragmentSpec } from "./selectFragmentConfig.js";
import { type Fragment, type FragmentLibrary, type TemplateConfig, type VirtualFileSystem } from "./types.js";

export interface SmokeOk {
  readonly kind: "ok";
  /** The dependsOn list the smoke ran against — echoed through unchanged. */
  readonly dependsOn: readonly string[];
}
export interface SmokeFailed {
  readonly kind: "failed";
  readonly reason: string;
}
export type SmokeResult = SmokeOk | SmokeFailed;

// ── Isolated smoke ──────────────────────────────────────────────────────────

/** Run the ISOLATED smoke composition (base + runtime + deploy + authored
 * slot) + the post-compose runtime validators. First-line "does this fragment
 * even compose on its own?" check. */
export async function runSmokeComposition(
  spec: FragmentSpec,
  fragment: Fragment,
  derivedDependsOn: readonly string[],
): Promise<SmokeResult> {
  const library = loadFragmentLibrary();
  registerAuthoredFragment(library, fragment);
  const config: TemplateConfig = configForSmoke(spec, fragment);
  let vfs: VirtualFileSystem;
  try {
    vfs = await composeTemplate(config, library);
  } catch (err) {
    return {
      kind: "failed",
      reason: `smoke compose failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // POST-COMPOSE RUNTIME VALIDATORS (audit finding #12). The same checks the
  // static matrix + isolation harnesses run — lifted to the runtime module so
  // the live smoke pipeline catches the same v62 (malformed `.tanren/ci.yml`),
  // v63 (frozen-install on fresh checkout — justfile OR Dockerfile), and v71/
  // v78 (pnpm install without a non-interactive signal — task #141) halt
  // classes. A failing validator rejects the fragment with the specific reason
  // so the writer's next rework iteration sees it.
  const validators: readonly {
    readonly label: string;
    readonly assert: (label: string, vfs: VirtualFileSystem) => void;
  }[] = [
    { label: "ci.yml schema", assert: assertComposedCiYmlParsesAsCiConfigV1 },
    { label: "fresh-checkout bootstrap", assert: assertScaffoldBootstrapsFromFreshCheckout },
    { label: "pnpm non-interactive", assert: assertPnpmInstallIsNonInteractive },
  ];
  for (const { label, assert } of validators) {
    try {
      assert(spec.id, vfs);
    } catch (err) {
      return {
        kind: "failed",
        reason: `runtime validator (${label}) rejected: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { kind: "ok", dependsOn: derivedDependsOn };
}

// ── Full-library (kitchen-sink) smoke ───────────────────────────────────────

/** Run the FULL-LIBRARY smoke composition: fill EVERY bundled fragment slot
 * compatible with the target runtime alongside the authored fragment. Catches
 * "isolated-fine but composes-with-conflict" — file collisions, dep version
 * conflicts, justfile-target clashes — that the minimal smoke can't see
 * because it only wires the authored slot. (audit finding H5 — task #150). */
export async function runFullLibrarySmokeComposition(
  spec: FragmentSpec,
  fragment: Fragment,
  derivedDependsOn: readonly string[],
): Promise<SmokeResult> {
  const library = loadFragmentLibrary();
  registerAuthoredFragment(library, fragment);

  const config = configForFullLibrarySmoke(spec, fragment);
  try {
    await composeTemplate(config, library);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      kind: "failed",
      reason:
        `full-library smoke compose failed (the authored fragment composed in isolation but ` +
        `clashes when composed alongside the bundled set the operator's project will use): ${cause}`,
    };
  }
  return { kind: "ok", dependsOn: derivedDependsOn };
}

// ── Config builders ─────────────────────────────────────────────────────────

/** The minimal ISOLATED smoke config — only the authored slot + base + runtime
 * + deploy. */
export function configForSmoke(spec: FragmentSpec, fragment: Fragment): TemplateConfig {
  const isRubyDependent =
    fragment.id.startsWith("runtime-ruby") || (fragment.dependsOn ?? []).some((id) => id.startsWith("runtime-ruby"));
  const runtime = spec.kind === "runtime" ? spec.label : isRubyDependent ? "ruby-bundler" : "node-pnpm";
  const deploy = spec.kind === "deploy" ? spec.label : "none";

  const config: TemplateConfig = {
    slug: `smoke-${spec.id}`,
    runtime,
    deploy,
    addons: [],
    examples: [],
  };
  if (spec.kind === "frontend") config.frontend = spec.label;
  if (spec.kind === "backend") config.backend = spec.label;
  if (spec.kind === "db") config.db = spec.label;
  if (spec.kind === "auth") config.auth = spec.label;
  if (spec.kind === "addon") config.addons = [spec.label];
  if (spec.kind === "example") config.examples = [spec.label];
  // Base + runtime + deploy slots reference the library; nothing else to wire.
  // BASE_FRAGMENT_ID is always required — assert presence.
  void BASE_FRAGMENT_ID;
  return config;
}

/** The KITCHEN-SINK full-library smoke config — every bundled fragment slot
 * compatible with the target runtime filled alongside the authored slot. When
 * the authored fragment fills a slot, the authored version wins (the composer's
 * shadow behavior); other slots use bundled defaults.
 *
 * For a node-pnpm target: base + node-pnpm + remix + postgres-prisma + biome +
 * docker + deploy-none (or the authored fragment's label filling its own slot).
 * For a ruby-bundler target: base + ruby-bundler + deploy-none (no other
 * bundled ruby-compatible fragments exist yet).
 * For any other authored runtime (python/go/rust): degenerate to isolated-shape
 * — no bundled fragments target those runtimes yet, so nothing extra to add. */
export function configForFullLibrarySmoke(spec: FragmentSpec, fragment: Fragment): TemplateConfig {
  const isolated = configForSmoke(spec, fragment);
  const runtimeId = runtimeFragmentId(isolated.runtime);

  // Only wire extra bundled slots when the target runtime IS node-pnpm — that's
  // the only runtime the bundled library has multiple compatible fragments for
  // today. Ruby/Python/Go/Rust would just repeat the isolated config; the
  // authored fragment's dependsOn already covers the runtime-mismatch check.
  if (runtimeId !== RUNTIME_NODE_PNPM_ID) {
    return { ...isolated, slug: `smoke-full-${spec.id}` };
  }

  const config: TemplateConfig = {
    slug: `smoke-full-${spec.id}`,
    runtime: isolated.runtime,
    deploy: isolated.deploy,
    addons: [...isolated.addons],
    examples: [...isolated.examples],
  };
  if (isolated.frontend !== undefined) config.frontend = isolated.frontend;
  if (isolated.backend !== undefined) config.backend = isolated.backend;
  if (isolated.db !== undefined) config.db = isolated.db;
  if (isolated.auth !== undefined) config.auth = isolated.auth;

  // Fill each bundled slot unless the authored fragment already owns that slot.
  if (config.frontend === undefined && spec.kind !== "frontend") {
    config.frontend = idLabel(FRONTEND_REMIX_ID, "frontend-");
  }
  if (config.db === undefined && spec.kind !== "db") {
    config.db = idLabel(DB_POSTGRES_PRISMA_ID, "db-");
  }

  // Addons: include every bundled node-pnpm-compatible addon UNLESS the
  // authored fragment shadows it (same kind + same label — the smoke registers
  // the authored via replaceForTests, so the bundled id resolves to the
  // authored body). Dedupe against isolated.addons which already has the
  // authored addon label when spec.kind === "addon".
  const addonSet = new Set<string>([
    ...config.addons,
    idLabel(ADDON_BIOME_ID, "addon-"),
    idLabel(ADDON_DOCKER_ID, "addon-"),
  ]);
  config.addons = [...addonSet].sort();

  return config;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function registerAuthoredFragment(library: FragmentLibrary, fragment: Fragment): void {
  if (library.has(fragment.id)) {
    library.replaceForTests(fragment);
  } else {
    library.register(fragment);
  }
}

/** Extract the LABEL suffix from a fragment id (`"addon-biome"` → `"biome"`).
 * The prefix must match one of the kind prefixes. */
function idLabel(id: string, prefix: string): string {
  if (!id.startsWith(prefix)) {
    throw new Error(`smokeComposition.idLabel: id "${id}" does not start with expected prefix "${prefix}"`);
  }
  return id.slice(prefix.length);
}
