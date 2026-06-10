// The canonical STACK-AGNOSTIC project skeleton — the "no-stack template" a
// from-scratch (greenfield) start authors, and the contract a brownfield repo is
// brought onto. This module is the SINGLE SOURCE of the contract SHAPE: Tanren
// knows ONLY this convention — a project declares its lifecycle in a `justfile`
// with conventional targets, and a generic `.tanren/ci.yml` (CiConfigV1) maps the
// lifecycle points to commands that defer to `just <target>`. Tanren names NO tech
// stack anywhere (no pnpm/node/cargo/python) — the stack commands live entirely in
// the project's `justfile`, which the project fills in.
//
// THE CONTRACT (Tanren reads only the left-hand side; the right-hand side is the
// project's to define):
//   - `just bootstrap` — install deps / prepare the workspace for the gate.
//   - `just tier-1`    — the cheap per-iteration gate (e.g. lint + typecheck). NO
//                        tests: tests arrive with features, so a scaffold pass is
//                        never blocked by a test tier.
//   - `just tier-2`    — the pre-audit gate (e.g. build + tests). A tier that runs
//                        tests writes a machine-readable JUnit report to
//                        ${JUNIT_REPORT_PATH} so Tanren's per-test ingest can read it.
//   - `just tier-3`    — the heaviest pre-merge gate (the merge authority).
//   - `just build` / `just deploy` — the build + deploy lifecycle the project owns.
//
// BLOCK STYLE is mandatory: Tanren's gate parser (engine/ci/yaml.ts) is a minimal
// subset parser that does NOT accept flow collections (`[per_iteration]` /
// `{ name: …, run: … }`) — those parse as bare scalars and fail the schema. The
// ci.yml below is block-style throughout, and round-trips through `resolveCiConfig`.

import { JUNIT_REPORT_PATH } from "../../ci/index.js";

// The conventional path of the justfile a project declares its lifecycle in. The
// brownfield config-injection writes this skeleton when the repo ships none, and
// the bootstrap LOUD-fallback probes for it before refusing to assume a stack.
export const SKELETON_JUSTFILE_PATH = "justfile";

// The conventional path of the native gate definition Tanren reads.
export const SKELETON_CI_CONFIG_PATH = ".tanren/ci.yml";

// The stack-AGNOSTIC `.tanren/ci.yml` (CiConfigV1). It maps the three lifecycle
// tiers to `just <target>` — NO stack command (pnpm/cargo/python/…) appears; the
// stack lives in the justfile. `bootstrap.run` is `just bootstrap`. The three tiers
// map 1:1 to the spec-loop lifecycle points: `fast` (per_iteration), `slow`
// (pre_audit), `merge` (pre_merge). This is the single source of the lifecycle map;
// the round-trip test parses THIS string through the real CiConfigV1 schema.
export const SKELETON_CI_CONFIG = `# .tanren/ci.yml — Tanren's native gate definition (CiConfigV1). Tanren runs these
# steps itself over SSH on the runner (Action-less delivery). The COMMANDS defer to
# \`just <target>\` — the stack (pnpm/cargo/python/swift/…) lives in the justfile, so
# Tanren assumes NO tech stack. A test tier DECLARES the JUnit report it writes via
# \`junitReport:\` so Tanren's per-test ingest reads EXACTLY that path (the per-test
# flaky→quarantine grain). The path is the project's declaration — Tanren names no
# test runner; \`${JUNIT_REPORT_PATH}\` is just the conventional default.
version: 1
bootstrap:
  run: just bootstrap
tiers:
  # tier-1 (per_iteration) — the cheap gate after every writer iteration.
  fast:
    - name: tier-1
      run: just tier-1
  # tier-2 (pre_audit) — build + tests at spec completion. It DECLARES its JUnit report
  # (junitReport) so Tanren ingests the per-test grain; have \`just tier-2\` write that path.
  slow:
    - name: tier-2
      run: just tier-2
      junitReport: ${JUNIT_REPORT_PATH}
  # tier-3 (pre_merge) — the heaviest thorough gate (the merge authority).
  merge:
    - name: tier-3
      run: just tier-3
when:
  fast:
    - per_iteration
  slow:
    - pre_audit
  merge:
    - pre_merge
`;

// The six conventional justfile targets, in lifecycle order, each with its header
// comment. This is the SINGLE SOURCE of the justfile SHAPE: both the stub skeleton
// below and the lifecycle-FILLED justfile (contractFiles.ts) render from it, so the
// target set, ordering, and recipe-body TAB discipline are defined exactly once.
const SKELETON_JUSTFILE_TARGETS: ReadonlyArray<{ readonly target: string; readonly comment: string }> = Object.freeze([
  { target: "bootstrap", comment: "install deps / prepare the workspace so the gate tiers can run." },
  { target: "tier-1", comment: "tier-1 — the cheap per-iteration gate (e.g. lint + typecheck). NO tests here." },
  {
    target: "tier-2",
    comment: `tier-2 — the pre-audit gate (e.g. build + tests). A test tier writes a JUnit\n# report to ${JUNIT_REPORT_PATH} so Tanren's per-test ingest can read it.`,
  },
  { target: "tier-3", comment: "tier-3 — the heaviest pre-merge gate (the merge authority)." },
  { target: "build", comment: "build the deployable artifact." },
  { target: "deploy", comment: "deploy the built artifact to the target." },
]);

// Render a justfile from a per-target recipe-body function. `body` returns the
// recipe's TAB-indented line(s) for a target (just requires a leading tab, not
// spaces — the caller MUST emit it). This is the one place the justfile header +
// target structure lives; the stub skeleton and the lifecycle-filled justfile both
// project through it so they can never drift in shape.
export function renderJustfile(body: (target: string) => string): string {
  const header =
    "# justfile — this project's lifecycle, the SINGLE place the tech stack lives.\n" +
    "# Tanren reads `.tanren/ci.yml`, which defers to these `just` targets; Tanren itself\n" +
    "# assumes NO stack. Each conventional target holds your stack's real command (pnpm /\n" +
    "# cargo / uv / swift / make / …).";
  const blocks = SKELETON_JUSTFILE_TARGETS.map(({ target, comment }) => `# ${comment}\n${target}:\n${body(target)}`);
  return `${header}\n\n${blocks.join("\n\n")}\n`;
}

// The stack-AGNOSTIC justfile skeleton. Every conventional target is a LOUD STUB:
// an unfilled target prints a clear "define this target for your stack" message and
// `exit 1` so it can NEVER silently pass a gate. The project FILLS these in with its
// real stack commands; the greenfield-vs-frozen install concern lives inside
// `just bootstrap` (the project's), NOT in Tanren. The recipe bodies are TAB-
// indented (just requires a tab, not spaces) — keep the literal tab below.
const STUB = (target: string): string =>
  `\t@echo "tanren: define '${target}' for this project's stack (edit the justfile)" && exit 1`;

export const SKELETON_JUSTFILE = renderJustfile(STUB);

// A short README explaining the contract, written alongside the skeleton so a human
// (or the writer agent) opening the from-scratch repo understands what to fill in.
export const SKELETON_README = `# Tanren project skeleton

This repo declares its lifecycle to Tanren through **two files** — and **no tech
stack is assumed**. Tanren reads the contract; you provide the stack.

## The contract

- **\`justfile\`** — the single place your stack lives. Fill each target with your
  stack's real command (pnpm / cargo / uv / swift / make / a build script / …):
  - \`bootstrap\` — install deps / prepare the workspace.
  - \`tier-1\` — the cheap per-iteration gate (lint + typecheck). No tests.
  - \`tier-2\` — the pre-audit gate (build + tests). A test tier writes a JUnit
    report to \`${JUNIT_REPORT_PATH}\`.
  - \`tier-3\` — the heaviest pre-merge gate (the merge authority).
  - \`build\` / \`deploy\` — the build + deploy lifecycle.
- **\`.tanren/ci.yml\`** — maps the lifecycle points (\`per_iteration\` / \`pre_audit\`
  / \`pre_merge\`) to \`just <target>\`. You usually don't touch this; it defers to
  the justfile.

Every justfile target ships as a LOUD STUB (\`exit 1\`) — an unfilled target fails
the gate loudly instead of silently passing. Fill them in for your stack.
`;

// The skeleton as a writable file set: the from-scratch scaffold authors all three,
// and brownfield config-injection injects the ci.yml (+ the justfile when the repo
// ships none). Wave B's scaffold writer consumes THIS export.
export interface SkeletonFile {
  path: string;
  content: string;
}

export const SKELETON_FILES: ReadonlyArray<SkeletonFile> = Object.freeze([
  { path: SKELETON_CI_CONFIG_PATH, content: SKELETON_CI_CONFIG },
  { path: SKELETON_JUSTFILE_PATH, content: SKELETON_JUSTFILE },
  { path: "README.md", content: SKELETON_README },
]);
