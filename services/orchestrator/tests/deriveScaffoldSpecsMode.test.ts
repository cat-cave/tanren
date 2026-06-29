// Audit finding #1 (v65 ship-blocker): EVERY foundation scaffold spec (scaffold ·
// build · deploy) must run in `specialize_seed` mode. PR #704 only set the field on
// the `scaffold` def; `build` and `deploy` defaulted to `from_scratch` even though
// their descriptions explicitly say "Build on the EXISTING justfile/toolchain on
// `main` — do NOT re-invent the stack". The mismatch handed the writer the
// from-scratch grading instruction ("Build everything ELSE — manifest/lockfile,
// sources, configs, tests, fixtures") — the exact v64 contradiction class one rung
// downstream from scaffold. This test pins the shape: all three foundation defs
// carry `mode: "specialize_seed"`.

import { describe, expect, it } from "vitest";
import { scaffoldSpecsFor } from "../src/engine/forge/interview/deriveScaffoldSpecs.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/types.js";
import type { SeededTemplate } from "../src/engine/templates/fragments/materialize.js";

const LIFECYCLE: CaptureLifecycle = {
  stack: "node-typescript",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm test",
  tier3: "pnpm test:e2e",
  build: "pnpm build",
  deploy: "vercel deploy --prod",
  upgrade: "pnpm update --latest",
  toolchain: [],
};

const SEED: SeededTemplate = {
  templateRef: "tanren://composed/seed@abc12345",
  validatedAt: "2026-06-26T00:00:00.000Z",
};

describe("scaffoldSpecsFor — foundation spec MODE (audit finding #1, v65 ship-blocker)", () => {
  // The three foundation defs are named scaffold/build/deploy (a stable contract
  // the derive's MilestoneStore + the operator's `apex` playbook both rely on).
  it("emits the three foundation specs in order: scaffold → build → deploy", () => {
    const specs = scaffoldSpecsFor(LIFECYCLE, SEED);
    expect(specs.map((s) => s.title)).toEqual(["scaffold", "build", "deploy"]);
  });

  // The v65 fix: every foundation spec carries `mode: "specialize_seed"` so the
  // writer's standing grading instruction matches what the workspace actually looks
  // like at the writer's first iteration (the composed seed is already in place +
  // proven green by composition). Before this fix, only `scaffold` set the field;
  // `build`/`deploy` defaulted to `from_scratch` and contradicted their own
  // description text.
  it.each(["scaffold", "build", "deploy"] as const)(
    "%s spec carries mode='specialize_seed' (audit finding #1)",
    (title) => {
      const specs = scaffoldSpecsFor(LIFECYCLE, SEED);
      const def = specs.find((s) => s.title === title);
      expect(def, `${title} spec exists`).toBeDefined();
      expect(def?.mode).toBe("specialize_seed");
    },
  );

  // The build/deploy descriptions explicitly tell the writer NOT to re-invent the
  // stack — "Build on the EXISTING justfile/toolchain" — which is the
  // specialize_seed contract. A defensive assertion so a future edit can't silently
  // drift the description back to from-scratch framing without flipping the mode.
  it("build/deploy descriptions name the EXISTING justfile/toolchain (consistent with specialize_seed mode)", () => {
    const specs = scaffoldSpecsFor(LIFECYCLE, SEED);
    const build = specs.find((s) => s.title === "build");
    const deploy = specs.find((s) => s.title === "deploy");
    expect(build?.description).toContain("EXISTING justfile/toolchain");
    expect(build?.description).toContain("do NOT re-invent the stack");
    expect(deploy?.description).toContain("just deploy");
    expect(deploy?.description).toContain("never a hardcoded deploy command");
  });

  // The dependency chain is preserved: build depends on scaffold; deploy depends
  // on build. The DAG's foundation walks scaffold → build → deploy, not parallel.
  it("serializes the foundation chain via dependsOnPrev (scaffold root, build → deploy)", () => {
    const specs = scaffoldSpecsFor(LIFECYCLE, SEED);
    // scaffold is the sole root; build chains off scaffold; deploy chains off build.
    expect(specs[0]?.dependsOnPrev).toBeUndefined();
    expect(specs[1]?.dependsOnPrev).toBe(true);
    expect(specs[2]?.dependsOnPrev).toBe(true);
  });
});
