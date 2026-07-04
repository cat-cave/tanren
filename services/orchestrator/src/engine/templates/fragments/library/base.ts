// THE BASE/ FRAGMENT — ALWAYS-INJECTED, NON-NEGOTIABLE TANREN OPINIONS.
//
// The user's load-bearing constraint: "Just because we want to take advantage of
// templates does not mean we want to allow users to sidestep all of the things that
// Tanren is opinionated on, like green CI, strong behavior tie-ins to tests, and
// functional demos." This fragment emits the STRUCTURAL surface every Tanren
// project carries; runtime/frontend/etc fragments FILL hooks INSIDE this surface,
// they never REPLACE it.
//
// What `base/` declares:
//   - `justfile` — the recipe SHELL with the mandatory targets (bootstrap, tier-1,
//     tier-2, tier-3, build) and `# TANREN-HOOK: <target>` insertion markers. The
//     composer's `processJustfile` splices fragment hook fills into these markers.
//   - `.tanren/ci.yml` — the native CI gate config with evidence declarations on
//     tier-2 + tier-3. The reportPath is a placeholder the runtime fragment fills;
//     the structure (which tiers have which evidence kind) is set HERE.
//   - `.gitignore` — the Tanren-mandatory exclusions (node_modules, dist, reports,
//     .env, .turbo, .stryker-tmp).
//   - `mise.toml` — toolchain pin with a `[tools]` placeholder the runtime fills.
//   - `features/.gitkeep` — Cucumber BDD home.
//   - `tests/.gitkeep` — unit-test home.
//   - `tests/mutation-baseline.test.ts` — asserts mutation-testing config exists so a
//     writer cannot ship a template structurally without Stryker.
//   - `tests/functional-demo.test.ts` — asserts a public-surface demo route returns
//     2xx so "functional demo" is STRUCTURALLY required by the test gate.
//   - `README.md` stub (the composer's `processReadme` rewrites it).
//
// IMMUTABLE FILES (BASE_PROTECTED_FILES): the composer's `assertBaseInvariantsHeld`
// re-checks the mutation-baseline + functional-demo skeleton tests post-compose; a
// fragment that deleted them throws. This is the structural guarantee.

import type { Fragment, TemplateConfig, VirtualFileSystem } from "../types.js";

export const BASE_FRAGMENT_ID = "base" as const;
export const BASE_FRAGMENT_VERSION = "1.2.0" as const;

/** The set of justfile targets the base fragment declares. `processJustfile` rejects
 * a fragment fill against an unknown target name. The `mutation` target was added in
 * PR-B (NB-2): mutation testing is a first-class tier the runtime fragment must wire
 * (node-pnpm → stryker, ruby-bundler → mutant) — a runtime that ships an empty
 * mutation hook is caught by `assertRuntimeFillsMutationHook` in the dogfood test. */
export const BASE_JUSTFILE_TARGETS: ReadonlySet<string> = new Set([
  "bootstrap",
  "tier-1",
  "tier-2",
  "tier-3",
  "build",
  "mutation",
]);

/** Files the base writes that EVERY composed template MUST still carry — re-asserted
 * post-compose. A fragment that silently dropped these is rejected as a hook bypass. */
export const BASE_PROTECTED_FILES: readonly string[] = [
  "justfile",
  ".tanren/ci.yml",
  ".gitignore",
  "tests/mutation-baseline.test.ts",
  "tests/functional-demo.test.ts",
];

const JUSTFILE = `# Tanren template — DO NOT remove or rename targets. Fragments fill the
# # TANREN-HOOK markers via VirtualFileSystem.appendToJustfileTarget; the
# composer's processJustfile splices them in. Wholesale target replacement
# throws at compose time (the user's load-bearing constraint).
set shell := ["bash", "-euo", "pipefail", "-c"]

# NON-INTERACTIVE CI SIGNAL (task #141 — apex v71/v78 halt class).
# Every recipe inherits CI=true — the industry-standard signal that a build is
# running unattended (no TTY, no prompts). pnpm 11 respects it and skips the
# modules-directory purge confirmation that otherwise HALTS with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY on the tanren-bootstrap SSH tier
# (which runs \`just bootstrap\` over an SSH channel with no PTY). Downstream
# tools (turborepo, husky, next.js build) also key off CI=true — a single top-
# level export applies to bootstrap + tier-1 + tier-2 + tier-3 + build +
# mutation, and to every stack, not just node-pnpm.
export CI := "true"

default:
  just --list

bootstrap:
# TANREN-HOOK: bootstrap

tier-1:
# TANREN-HOOK: tier-1

tier-2:
# TANREN-HOOK: tier-2

tier-3:
# TANREN-HOOK: tier-3

build:
# TANREN-HOOK: build

# Mutation testing — PR-B made this a first-class tier (NB-2). The runtime fragment
# fills the body (node-pnpm → stryker run + json report; ruby-bundler → mutant run).
# The composer rejects a runtime that leaves this empty via the dogfood-test
# assertion (see assertRuntimeFillsMutationHook).
mutation:
# TANREN-HOOK: mutation
`;

// The base ci.yml — evidence declarations are on the slow + merge tiers with a
// placeholder `__TANREN_REPORT_PATH__` token that `processCiYml` replaces with the
// runtime fragment's declared `reportPath`. minTests=1 enforces "at least one test
// ran" (the v57 lesson — exit-0 alone is not a proof; see ci/schema.ts).
//
// TIER VOCABULARY: the keys MUST be the CiConfigV1 schema vocabulary
// (`fast`/`slow`/`merge`) — the schema (services/orchestrator/src/engine/ci/schema.ts)
// REQUIRES `fast` + `slow`, and any tier mapped to `pre_merge` must declare positive
// evidence. The step `name` inside each tier names the just target it runs (tier-1
// / tier-2 / tier-3), matching the justfile targets the base declares. A prior
// shape (`tiers.tier-1`/`tier-2`/`tier-3`) failed CiConfigV1.safeParse with
// `tiers.fast: expected array` and surfaced as the apex v62 halt (task #80); the
// matrix-coverage + isolation harnesses now parse every composed ci.yml against
// CiConfigV1 so that class of bug never escapes the test surface again.
const CI_YML = `version: 1
bootstrap:
  run: "just bootstrap"
tiers:
  fast:
    - name: "tier-1"
      run: "just tier-1"
  slow:
    - name: "tier-2"
      run: "just tier-2"
      evidence:
        kind: "junit"
        reportPath: "__TANREN_REPORT_PATH__"
        minTests: 1
  merge:
    - name: "tier-3"
      run: "just tier-3"
      evidence:
        kind: "artifact"
        path: "dist"
    - name: "mutation"
      run: "just mutation"
      evidence:
        kind: "artifact"
        path: "reports/mutation"
when:
  fast:
    - "per_iteration"
  slow:
    - "pre_audit"
  merge:
    - "pre_merge"
deploy:
  run: "just build"
`;

const GITIGNORE = `# Tanren base/ — non-negotiable exclusions. Add stack-specific lines via fragments;
# do not remove these.
node_modules/
dist/
build/
reports/
coverage/
.env
.env.*
!.env.example
.turbo/
.stryker-tmp/
.direnv/
*.log
.DS_Store
`;

const MISE_TOML = `# Tanren base/ — toolchain pin. Runtime fragments fill the [tools] block; do not
# add deps via env vars (mise pins the version we ran the gate on).
[tools]
`;

const MUTATION_BASELINE_TEST = `// TANREN BASE/ — mutation-baseline structural assertion. A template ships a mutation
// test gate; this test fails at gate time when the mutation config goes missing so a
// writer cannot ship a template structurally without Stryker (the user's constraint).
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("tanren base / mutation baseline", () => {
  it("ships a stryker config so the mutation gate is structurally present", () => {
    const root = process.cwd();
    const candidates = ["stryker.conf.mjs", "stryker.conf.js", "stryker.conf.json", ".stryker.conf.mjs"];
    const present = candidates.some((name) => existsSync(join(root, name)));
    expect(present, "expected a stryker config at the project root").toBe(true);
  });
});
`;

const FUNCTIONAL_DEMO_TEST = `// TANREN BASE/ — functional-demo structural assertion. A template ships a public
// demo surface (a route, a CLI, an exposed function) and a test that proves it works
// end-to-end. This skeleton asserts the demo entry exists; fragments REPLACE the
// inner expect() with a real 2xx / contract check via their own follow-up test. The
// test never deletes — fragments add a second test that exercises the real surface.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("tanren base / functional demo", () => {
  it("ships a public demo surface (entry file present)", () => {
    const root = process.cwd();
    const candidates = ["src/demo.ts", "src/index.ts", "app/page.tsx", "app/main.ts", "lib/demo.rb"];
    const present = candidates.some((name) => existsSync(join(root, name)));
    expect(present, "expected one of the demo entry files: " + candidates.join(", ")).toBe(true);
  });
});
`;

const README_STUB = `# tanren-template

Composed by the Tanren template composer (this README is rewritten by the post-
processor with the matrix-point summary).
`;

export const baseFragment: Fragment = {
  id: BASE_FRAGMENT_ID,
  version: BASE_FRAGMENT_VERSION,
  kind: "base",
  contract: {},
  // No external deps — base is always first.
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("justfile", JUSTFILE);
    vfs.write(".tanren/ci.yml", CI_YML);
    vfs.write(".gitignore", GITIGNORE);
    vfs.write("mise.toml", MISE_TOML);
    vfs.write("features/.gitkeep", "");
    vfs.write("tests/.gitkeep", "");
    vfs.write("tests/mutation-baseline.test.ts", MUTATION_BASELINE_TEST);
    vfs.write("tests/functional-demo.test.ts", FUNCTIONAL_DEMO_TEST);
    vfs.write("README.md", README_STUB);
  },
};
