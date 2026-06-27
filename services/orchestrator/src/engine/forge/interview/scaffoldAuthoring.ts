// Author the greenfield seed-instantiation scaffold spec.
//
// THE ONE PATH (docs/roadmap/templating-system.md). Every project DAG's `scaffold`
// spec is the SHRUNKEN instantiate-the-seed authoring: a fragment-composed
// template has been materialized into a fresh seed repo (engine/templates/
// fragments/materialize.ts), and the run path clones it into the project's
// workspace BEFORE the writer starts. The writer's job is to specialize the seed
// — rename product placeholders to the captured identity, wire the deploy/env to
// the captured deploy command, update READMEs. The writer NEVER authors from
// scratch and NEVER touches the contract files (the seed established them).
//
// The from-scratch authoring this module used to host (and the dual
// project-vs-template_build branching) is GONE — there is no template_build
// scaffoldOrigin, no agent template-build DAG. A missing fragment triggers the
// per-fragment authoring DAG (selectFragmentConfig → missing-fragments → spawn
// authoring runs → retry), not a whole-template author-from-scratch.

import { SKELETON_CI_CONFIG_PATH, SKELETON_JUSTFILE_PATH } from "../scaffold/index.js";
import type { SeededTemplate } from "../../templates/fragments/materialize.js";
import type { CaptureLifecycle } from "./types.js";

// Thrown when the scaffold is asked to author a project that never captured a
// lifecycle. FAIL LOUD (no silent Node default) — the contract's core invariant.
export class MissingLifecycleError extends Error {
  constructor() {
    super(
      "greenfield scaffold requires the architecture step to capture a project lifecycle " +
        "(stack + bootstrap/tier-1/tier-2/tier-3/build/deploy commands); none was captured. " +
        "Tanren bakes in NO stack — the lifecycle must be declared, never defaulted.",
    );
  }
}

/**
 * Build the SCAFFOLD spec description for a seed-instantiate authoring task. The
 * seed repo was composed from fragments + pushed before the writer runs; the
 * writer specializes it — never re-scaffolds the stack or re-authors the contract
 * files.
 */
export function buildSeedScaffoldDescription(lifecycle: CaptureLifecycle, seed: SeededTemplate): string {
  return [
    `SEED FROM TEMPLATE — do NOT author the project from scratch. The greenfield repo was SEEDED from the ` +
      `composed seed \`${seed.repoRef}\` (ref \`${seed.templateRef}\`, composed ${seed.validatedAt} @ ` +
      `\`${seed.validatedSha}\`): its conforming files — the \`${SKELETON_JUSTFILE_PATH}\` + ` +
      `\`${SKELETON_CI_CONFIG_PATH}\` contract and a working ${lifecycle.stack} skeleton — are ALREADY COMMITTED ` +
      `as the scaffold base. The seed's gates are PROVEN by composition (base invariants re-checked, ci.yml ` +
      "evidence block filled, every fragment validated in isolation); do NOT re-author or weaken them.",
    "",
    "Your job is to INSTANTIATE the seed for THIS product — adapt only the product-specific surface:",
    "  - rename the placeholder package/app/slug to the product's identity,",
    "  - wire the product's deploy target + runtime env into the seed's `just deploy`/env hooks,",
    "  - update READMEs/metadata to the product (keep the contract files' SHAPE intact).",
    "",
    "Do NOT re-scaffold the stack, re-invent the toolchain, or replace the contract files — the seed is a " +
      "validated instance of the contract; specialize it, never restart from an empty repo.",
  ].join("\n");
}

/** The acceptance criteria for a seed-instantiate authoring task. The bar is
 * INSTANTIATION (the seed is already a proven-green contract instance), not
 * from-scratch authoring. */
export function buildSeedScaffoldAcceptanceCriteria(seed: SeededTemplate): string[] {
  return [
    `given the template-seeded repo (from \`${seed.repoRef}\`), when the scaffold lands, then the product ` +
      "identity (package/app/slug, deploy/env wiring, READMEs) is adapted onto the seed — NOT a from-scratch rewrite",
    `given the seeded contract files, when the scaffold lands, then \`${SKELETON_JUSTFILE_PATH}\` and ` +
      `\`${SKELETON_CI_CONFIG_PATH}\` keep their composed SHAPE (the seed's proven gates are intact, not weakened)`,
    "given the specialized seed, when `just bootstrap`, `just tier-1`, and `just build` run, then each exits 0 " +
      "(the seed was proven green by composition; specialization kept it green)",
  ];
}
