// greenfield onboarding: the FOUNDATION SCAFFOLD SPECS (scaffold · build · deploy).
//
// Split out of `derive.ts` (file-size discipline): the foundation specs the derive
// creates first, derived FROM THE CAPTURED LIFECYCLE (the stack-flexible contract,
// docs/roadmap/stack-flexible-contract.md) — Tanren bakes in NO stack. The
// architecture step captures the project's concrete lifecycle; the lifecycle is
// PERSISTED onto the project config (in `derive.ts`) so the RUN path MATERIALIZES
// the contract files (`justfile` + `.tanren/ci.yml`) DETERMINISTICALLY from it
// (engine/forge/scaffold/contractFiles.ts) — they are NEVER LLM-authored (the v27
// fix: the LLM writer reliably mangled the ci.yml YAML shape; the hardcoded-pnpm
// `scaffoldCiConfig.ts` example is GONE — the apex v25/v26 bug).
//
// TEMPLATING WAVE 3 — when a template was SELECTED (templating-system.md §3), the
// `scaffold` spec SHRINKS to template instantiation; otherwise it is the unchanged
// from-scratch authoring (the guaranteed fallback). See `scaffoldSpecsFor`.
//
// Fixes preserved here (DOMAIN knowledge — not a walker-wide rule):
//   1. `dependsOnPrev` SERIALIZES the foundation into a chain (`scaffold` is the
//      sole root; `build` then `deploy` chain off it), so one branch establishes
//      the authoritative justfile/toolchain on `main` before the next builds on it
//      (no incompatible-stack races off an empty repo).
//   2. The `scaffold` spec's WRITER authors the project CODE (the contract files
//      are materialized deterministically — it never touches them); the
//      `build`/`deploy` specs route through the conventional `just build` /
//      `just deploy` targets — never a hardcoded build/deploy command.
//   3. The SCAFFOLD BAR is structure + bootstrap/tier-1/build passing — a thorough
//      test SUITE is NOT required at scaffold (tests arrive with the feature specs).

import {
  buildScaffoldAcceptanceCriteria,
  buildScaffoldDescription,
  buildSeedScaffoldAcceptanceCriteria,
  buildSeedScaffoldDescription,
  MissingLifecycleError,
} from "./scaffoldAuthoring.js";
// Re-exported so `derive.ts` sources the scaffold-derivation surface from one
// module (the lifecycle guard travels with the scaffold authoring it gates).
export { MissingLifecycleError };
import type { TemplateSelectionDecision } from "./templateSelection.js";
import type { CaptureLifecycle } from "./types.js";

export interface ScaffoldSpecDef {
  title: string;
  description: string;
  // The acceptance criteria the writer must satisfy. When absent, a generic
  // "pipeline is green" criterion is synthesized in the create loop.
  acceptanceCriteria?: string[];
  // When true, this spec `dependsOn` the PREVIOUS scaffold spec in the list — the
  // wiring that serializes the foundation into a chain instead of parallel roots.
  dependsOnPrev?: boolean;
}

// The adaptation work a PARTIAL match leaves for the writer: the build + deploy
// lifecycle commands the project declared, which a partial-match template may not
// fully wire. Expressed as adaptation criteria the seed scaffold spec carries (so a
// partial seed still ends with the project's own build/deploy lifecycle satisfied).
// STACK-AGNOSTIC: the commands come from the captured lifecycle, never a literal.
function partialMatchAdaptations(lifecycle: CaptureLifecycle): string[] {
  return [
    `the project's \`just build\` runs its declared build (\`${lifecycle.build.trim()}\`) and exits 0`,
    `the project's \`just deploy\` runs its declared deploy (\`${lifecycle.deploy.trim()}\`) to the chosen target`,
  ];
}

// Build the foundation scaffold specs from the captured lifecycle. The `scaffold`
// spec's writer authors the project CODE (the contract files are MATERIALIZED
// deterministically by the run, not by the writer); `build` and `deploy` route
// through the conventional `just build` / `just deploy` targets the materialized
// contract established — so the deploy/build paths invoke the PROJECT's declared
// command, never a hardcoded assumption.
//
// TEMPLATING WAVE 3 — when a template was SELECTED (`decision.kind` strong/partial),
// the `scaffold` spec SHRINKS: the writer INSTANTIATES the template seed (adapt
// product names/deploy/env, plus the partial-match adaptations) instead of authoring
// from scratch (templating-system.md §3). When no template matched (none/blocked, or
// selection skipped), the `scaffold` spec is the UNCHANGED from-scratch authoring —
// the guaranteed fallback. The `build`/`deploy` specs are identical either way (they
// always route through the conventional `just build`/`just deploy` targets).
export function scaffoldSpecsFor(lifecycle: CaptureLifecycle, decision?: TemplateSelectionDecision): ScaffoldSpecDef[] {
  const seeded = decision?.selected !== undefined && (decision.kind === "strong" || decision.kind === "partial");
  // The partial-match adaptation work: the lifecycle capabilities the template's
  // deploy/framework did NOT cover (a strong match needs none — pure instantiation).
  const adaptations = seeded && decision?.kind === "partial" ? partialMatchAdaptations(lifecycle) : [];
  const scaffoldSpec: ScaffoldSpecDef =
    seeded && decision?.selected !== undefined
      ? {
          title: "scaffold",
          description: buildSeedScaffoldDescription(lifecycle, decision.selected, adaptations),
          acceptanceCriteria: buildSeedScaffoldAcceptanceCriteria(decision.selected, adaptations),
        }
      : {
          title: "scaffold",
          description: buildScaffoldDescription(lifecycle),
          acceptanceCriteria: buildScaffoldAcceptanceCriteria(lifecycle),
        };
  return [
    scaffoldSpec,
    {
      title: "build",
      description:
        `Wire the project's build so the deployable artifact is produced via the conventional ` +
        `\`just build\` target the scaffold established (for ${lifecycle.stack}: \`${lifecycle.build.trim()}\`). ` +
        "Build on the EXISTING justfile/toolchain on `main` — do NOT re-invent the stack or bypass `just build`.",
      acceptanceCriteria: [
        "given the scaffolded repo, when `just build` runs, then it produces the deployable artifact and exits 0",
      ],
      dependsOnPrev: true,
    },
    {
      title: "deploy",
      description:
        `Wire the project's deploy so it ships via the conventional \`just deploy\` target the scaffold ` +
        `established (for ${lifecycle.stack}: \`${lifecycle.deploy.trim()}\`). Route deploy ONLY through ` +
        "`just deploy` — never a hardcoded deploy command or a Node/platform assumption.",
      acceptanceCriteria: [
        "given a built artifact, when `just deploy` runs, then it ships to the deploy target via the conventional `just deploy` (no hardcoded deploy command)",
      ],
      dependsOnPrev: true,
    },
  ];
}
