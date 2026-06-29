// greenfield onboarding: the FOUNDATION SCAFFOLD SPECS (scaffold · build · deploy).
//
// Split out of `derive.ts` (file-size discipline): the foundation specs the derive
// creates first, derived FROM THE CAPTURED LIFECYCLE (the stack-flexible contract,
// docs/operator-guide/ci-config.md) — Tanren bakes in NO stack. The architecture
// step captures the project's concrete lifecycle; the lifecycle is PERSISTED onto
// the project config (in `derive.ts`) so the RUN path MATERIALIZES the contract
// files (`justfile` + `.tanren/ci.yml`) DETERMINISTICALLY from it — they are NEVER
// LLM-authored.
//
// THE ONE-PATH DOCTRINE (docs/roadmap/templating-system.md). Every project DAG's
// `scaffold` spec instantiates a SEED — the fragment composer + the materializer
// produced a real seed repo before this derive runs. The writer specializes the
// seed; it never authors the project from scratch. There is no dual scaffoldOrigin
// (the project-vs-template_build branching is gone), no agent template-build path.
//
// Fixes preserved here (DOMAIN knowledge — not a walker-wide rule):
//   1. `dependsOnPrev` SERIALIZES the foundation into a chain (`scaffold` is the
//      sole root; `build` then `deploy` chain off it).
//   2. The `scaffold` spec's WRITER specializes the seed (the contract files came
//      from the seed); the `build`/`deploy` specs route through the conventional
//      `just build` / `just deploy` targets — never a hardcoded command.
//   3. The SCAFFOLD BAR is structure + bootstrap/tier-1/build passing — a thorough
//      test SUITE is NOT required at scaffold (tests arrive with the feature specs).
//   4. EVERY foundation spec (`scaffold` · `build` · `deploy`) runs in
//      `specialize_seed` mode — they all SPECIALIZE surfaces the composed seed
//      already shipped (build/deploy wire through the seed's `just build` / `just
//      deploy` recipes; the writer must not re-invent the toolchain).

import {
  buildSeedScaffoldAcceptanceCriteria,
  buildSeedScaffoldDescription,
  MissingLifecycleError,
} from "./scaffoldAuthoring.js";
// Re-exported so `derive.ts` sources the scaffold-derivation surface from one
// module (the lifecycle guard travels with the scaffold authoring it gates).
export { MissingLifecycleError };
import type { SeededTemplate } from "../../templates/fragments/materialize.js";
import type { SpecMode } from "../../state/spec.js";
import type { CaptureLifecycle } from "./types.js";

export interface ScaffoldSpecDef {
  title: string;
  description: string;
  // The acceptance criteria the writer must satisfy.
  acceptanceCriteria?: string[];
  // When true, this spec `dependsOn` the PREVIOUS scaffold spec in the list — the
  // wiring that serializes the foundation into a chain instead of parallel roots.
  dependsOnPrev?: boolean;
  // Task #86 (v64 root cause): the writer-prompt MODE the spec is created with.
  // EVERY foundation spec (`scaffold` · `build` · `deploy`) sets `specialize_seed`
  // — the composed seed is in place + proven green, and `build`/`deploy` SPECIALIZE
  // the seed's `just build` / `just deploy` recipes (they must not re-invent the
  // stack). Behavior/schema specs created downstream OMIT the field and default to
  // `from_scratch` at `createSpec`. Omitted ⇒ the default at `createSpec`.
  mode?: SpecMode;
}

/**
 * Build the foundation scaffold specs from the captured lifecycle + the
 * fragment-composed seed. The `scaffold` spec INSTANTIATES the seed (the writer
 * specializes the seed for THIS product); `build` and `deploy` route through the
 * conventional `just build` / `just deploy` targets the seed established.
 *
 * MODE (task #86 — v64 root cause): EVERY foundation spec (`scaffold` · `build` ·
 * `deploy`) opts INTO `specialize_seed` mode so `writerPromptFor()` emits the
 * seeded-mode standing instructions ("the composed seed is already in place +
 * proven green; touch ONLY product-identity surfaces") instead of the brownfield/
 * legacy "build everything ELSE — manifest/lockfile, sources, configs, tests"
 * guidance that produced v64's 6-hour non-converging writer-checker loop. `build`
 * and `deploy` are not exceptions: their job is to SPECIALIZE the seed's
 * conventional `just build` / `just deploy` recipes (which already came in the
 * composed seed); a `from_scratch` standing instruction here would explicitly tell
 * the writer to "Build everything ELSE — manifest/lockfile, sources, configs,
 * tests, fixtures", directly contradicting the spec text that says "Build on the
 * EXISTING justfile/toolchain on `main` — do NOT re-invent the stack" — the exact
 * v64 contradiction class one rung downstream from `scaffold`.
 */
export function scaffoldSpecsFor(lifecycle: CaptureLifecycle, seed: SeededTemplate): ScaffoldSpecDef[] {
  const scaffoldSpec: ScaffoldSpecDef = {
    title: "scaffold",
    description: buildSeedScaffoldDescription(lifecycle, seed),
    acceptanceCriteria: buildSeedScaffoldAcceptanceCriteria(seed),
    // The composed seed (manifest, lockfile, configs, contract files, source skeleton)
    // is ALREADY in place + proven green at this spec's first writer iteration; mode
    // selects the standing instructions that say so.
    mode: "specialize_seed",
  };
  return [
    scaffoldSpec,
    {
      title: "build",
      description:
        `Wire the project's build so the deployable artifact is produced via the conventional ` +
        `\`just build\` target the seed established (for ${lifecycle.stack}: \`${lifecycle.build.trim()}\`). ` +
        "Build on the EXISTING justfile/toolchain on `main` — do NOT re-invent the stack or bypass `just build`.",
      acceptanceCriteria: [
        "given the scaffolded repo, when `just build` runs, then it produces the deployable artifact and exits 0",
      ],
      dependsOnPrev: true,
      // The seed's `just build` recipe is already in place and proven green by composition;
      // this spec SPECIALIZES that surface for the project's artifact. `from_scratch` would
      // tell the writer "Build everything ELSE — manifest/lockfile, sources, configs, tests"
      // — directly contradicting the description above.
      mode: "specialize_seed",
    },
    {
      title: "deploy",
      description:
        `Wire the project's deploy so it ships via the conventional \`just deploy\` target the seed ` +
        `established (for ${lifecycle.stack}: \`${lifecycle.deploy.trim()}\`). Route deploy ONLY through ` +
        "`just deploy` — never a hardcoded deploy command or a Node/platform assumption.",
      acceptanceCriteria: [
        "given a built artifact, when `just deploy` runs, then it ships to the deploy target via the conventional `just deploy` (no hardcoded deploy command)",
      ],
      dependsOnPrev: true,
      // Same reasoning as `build`: the seed's `just deploy` recipe is already in place;
      // this spec SPECIALIZES it for the project's deploy target.
      mode: "specialize_seed",
    },
  ];
}
