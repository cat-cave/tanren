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

// The conventional path of the project's TOOLCHAIN declaration
// (environment-management.md §3 Layer 1): `mise.toml`, a `[tools]` table of the
// project's declared tool→version set. Materialized DETERMINISTICALLY from the
// lifecycle's `toolchain` list (NEVER LLM-authored, like the justfile) and provisioned
// at workspace-prep via `mise install`. Absent when the project declares no toolchain.
export const SKELETON_MISE_CONFIG_PATH = "mise.toml";

// Escape a value for a TOML basic (double-quoted) string: `\` and `"` so a
// version-spec can never break out of the quoted string in the `[tools]` table.
function escapeTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

// Render a deterministic `mise.toml` `[tools]` table from the project's declared
// toolchain — a LIST of {name, version} entries. A PURE projection — no stack literal,
// no LLM, no invented version. Tools are emitted in a STABLE (name-sorted) order so the
// file is byte-deterministic, and DE-DUPED by name (last-wins) so a repeated tool can
// never emit a duplicate `[tools]` key. Each version is rendered as a TOML basic
// string, with `\` and `"` escaped so a version-spec can never break out of the quoted
// string. The caller (contractFiles.ts) only renders this when the list is NON-EMPTY —
// an empty toolchain materializes NO mise.toml at all (Tanren invents no versions).
export function renderMiseToml(toolchain: readonly { name: string; version: string }[]): string {
  // De-dup by name, last-wins, so a repeated tool collapses to one `[tools]` key.
  const byName = new Map<string, string>();
  for (const entry of toolchain) {
    byName.set(entry.name, entry.version);
  }
  const tools = [...byName.keys()]
    .sort()
    .map((name) => `${name} = "${escapeTomlString(byName.get(name) ?? "")}"`)
    .join("\n");
  return (
    "# mise.toml — this project's TOOLCHAIN, the versions of the tools its stack needs.\n" +
    "# Tanren materializes this DETERMINISTICALLY from the project's declared toolchain\n" +
    "# (no LLM) and provisions it at workspace-prep via `mise install` in user space —\n" +
    "# so a bare `node`/`pnpm`/etc in the justfile resolves to THESE versions. Tanren's\n" +
    "# own harness (codex) stays on the runner's isolated node, untouched.\n" +
    "[tools]\n" +
    `${tools}\n`
  );
}

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
# upgrade (environment-management.md §4.5) — the dependency-bump verb a version-change
# DAG node runs. Defers to \`just upgrade\` (the stack's \`pnpm update --latest\` /
# \`cargo update\` / … lives in the justfile). Tanren runs it as a GATED node, never a
# side stream — a breaking bump is rejected loudly and main never breaks.
upgrade:
  run: just upgrade
# deploy — the project's deploy COMMAND (the ci.yml home for the lifecycle deploy point).
# Defers to \`just deploy\` (the stack's release command lives in the justfile). Tanren names
# no deploy tool; the deploy PROVIDER/TARGET (the app + credentials) is a separate
# org-integration concern, never a stack/target branch here.
deploy:
  run: just deploy
tiers:
  # tier-1 (per_iteration) — the cheap gate after every writer iteration.
  fast:
    - name: tier-1
      run: just tier-1
  # tier-2 (pre_audit) — build + tests at spec completion. It DECLARES its JUnit report
  # (junitReport) so Tanren ingests the per-test grain AND a POSITIVE EVIDENCE contract
  # (apex v57 task #64): the gate rejects exit-0 with zero tests run (the green-by-accident
  # class). Have \`just tier-2\` write a JUnit report to the declared path containing at
  # least one test.
  slow:
    - name: tier-2
      run: just tier-2
      junitReport: ${JUNIT_REPORT_PATH}
      evidence:
        kind: junit
        reportPath: ${JUNIT_REPORT_PATH}
        minTests: 1
  # tier-3 (pre_merge) — the heaviest thorough gate (the merge authority). Also declares
  # JUnit evidence (minTests: 1) so the merge gate cannot ship green-by-accident — a
  # tier-3 that runs only lint cannot be the merge authority.
  merge:
    - name: tier-3
      run: just tier-3
      junitReport: ${JUNIT_REPORT_PATH}
      evidence:
        kind: junit
        reportPath: ${JUNIT_REPORT_PATH}
        minTests: 1
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
  {
    target: "upgrade",
    comment:
      "upgrade — bump dependencies to latest + regenerate the lockfile (e.g.\n# 'pnpm update --latest' | 'cargo update' | 'uv lock --upgrade' | 'go get -u ./...').\n# Tanren runs this as a GATED DAG node (environment-management.md §4.5) — never a\n# side stream — so a breaking bump is rejected without ever breaking main.",
  },
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

// The LOUD-STUB recipe body for a target, exported so the lifecycle-filled justfile
// (contractFiles.ts) renders it for an OPTIONAL verb the project declared no command
// for (e.g. `upgrade=""`): an unfilled target `exit 1`s rather than silently passing.
export function stubRecipeBody(target: string): string {
  return STUB(target);
}

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
