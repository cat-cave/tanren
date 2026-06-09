// Author the greenfield monorepo-scaffold spec FROM the captured lifecycle.
//
// The stack-flexible contract (docs/roadmap/stack-flexible-contract.md): Tanren
// knows NO stack. A project DECLARES its lifecycle in a `justfile` (the
// conventional targets `bootstrap`/`tier-1`/`tier-2`/`tier-3`/`build`/`deploy`
// hold the ACTUAL stack commands) + a stable, stack-agnostic `.tanren/ci.yml`
// that maps the lifecycle to `just <target>`. The scaffold starts from the
// "bare skeleton" (justfile stubs + ci.yml + README) and FILLS the justfile
// targets with the stack commands the architecture step captured.
//
// This replaces the deleted `scaffoldCiConfig.ts`, which hardcoded a pnpm/vitest
// `.tanren/ci.yml` example — the apex v25/v26 bug: the interview captured the
// architecture but the scaffold IGNORED it and baked in Node/pnpm. Here there is
// ZERO hardcoded stack: every command in the authored instruction comes from the
// captured `CaptureLifecycle`. A Rust capture yields cargo commands; a TS capture
// yields pnpm; a novel-translation capture yields pandoc — all from the
// declaration, never from Tanren's TypeScript.
//
// SEAM (Wave A): the bare-skeleton CONTENT (the stub justfile + the stable
// ci.yml + the README) is owned by Wave A's stack-agnostic skeleton export. Until
// that export wires in at reconciliation, this module references the skeleton's
// SHAPE from the contract doc (the conventional target names + the ci.yml
// lifecycle→`just <target>` map) and instructs the writer to author it. When the
// export lands, `BARE_SKELETON_REF` below is replaced by the imported skeleton.

import type { CaptureLifecycle } from "./types.js";

// The conventional justfile targets, in lifecycle order, paired with the
// `CaptureLifecycle` field that fills each. Tanren's ONLY general knowledge: the
// target NAMES + tier→lifecycle semantics (the contract §4) — never the commands.
const CONVENTIONAL_TARGETS: ReadonlyArray<{
  readonly target: string;
  readonly field: keyof Omit<CaptureLifecycle, "stack">;
  readonly semantics: string;
}> = [
  { target: "bootstrap", field: "bootstrap", semantics: "install/restore dependencies" },
  { target: "tier-1", field: "tier1", semantics: "cheap per-iteration checks (fast tier · per_iteration)" },
  { target: "tier-2", field: "tier2", semantics: "slower pre-audit checks incl. tests (slow tier · pre_audit)" },
  { target: "tier-3", field: "tier3", semantics: "the full pre-merge gate (merge tier · pre_merge)" },
  { target: "build", field: "build", semantics: "produce the deployable artifact" },
  { target: "deploy", field: "deploy", semantics: "ship the artifact to the deploy target" },
] as const;

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

// Render the captured lifecycle as the justfile-target → command table the writer
// fills the bare skeleton's stubs with. PURE projection of the capture — no stack
// literal appears here.
function renderLifecycleTable(lifecycle: CaptureLifecycle): string {
  return CONVENTIONAL_TARGETS.map(({ target, field, semantics }) => {
    const command = lifecycle[field].trim();
    return `  - just ${target} (${semantics}):\n      ${command.replaceAll("\n", "\n      ")}`;
  }).join("\n");
}

// A clearly-marked reference to Wave A's not-yet-wired bare-skeleton export. Until
// the export lands, the writer authors the skeleton's shape from the contract.
const BARE_SKELETON_REF =
  "the bare stack-agnostic skeleton (Wave A's skeleton export — a `justfile` with the " +
  "six conventional STUB targets, a stable `.tanren/ci.yml` mapping each tier to `just " +
  "<target>`, and a README explaining the contract)";

// Build the `monorepo scaffold` spec description from the captured lifecycle. The
// writer is instructed to: (1) start from the bare skeleton; (2) FILL the
// justfile's conventional targets with the captured stack commands; (3) keep the
// `.tanren/ci.yml` as the stable lifecycle→`just <target>` map (the writer does
// NOT re-define it — Wave A owns its shape). NO hardcoded stack: the commands are
// the project's own declaration.
export function buildScaffoldDescription(lifecycle: CaptureLifecycle): string {
  return [
    `Scaffold the project for the chosen stack — ${lifecycle.stack} — by starting from ${BARE_SKELETON_REF} ` +
      "and FILLING its justfile targets with the project's declared lifecycle commands. Do NOT invent a stack: " +
      "the stack and every command below come from the architecture step's lifecycle declaration.",
    "",
    "Author the `justfile` so each conventional target runs the project's real command(s):",
    renderLifecycleTable(lifecycle),
    "",
    "Keep the stable `.tanren/ci.yml` from the skeleton EXACTLY as the lifecycle→`just <target>` map " +
      "(`bootstrap: just bootstrap`; the `fast` tier runs `just tier-1` at `per_iteration`, `slow` runs " +
      "`just tier-2` at `pre_audit`, `merge` runs `just tier-3` at `pre_merge`). Do NOT inline stack " +
      "commands into the ci.yml — all stack specifics live in the justfile; the ci.yml stays tiny + " +
      "stack-agnostic (a CiConfigV1, NOT a GitHub Actions workflow).",
    "",
    "The justfile targets must be human-runnable locally (`just tier-1`). A tier that runs tests must write a " +
      "machine-readable test report to a known path (the test-report convention) so flaky-intelligence ingests it. " +
      "Make the scaffold real for this stack — real dependency manifests/lockfiles, a minimal source entrypoint, " +
      "and a committed ignore file for build/install/report artifacts — NOT stubs or placeholders.",
  ].join("\n");
}

// The acceptance criteria for the lifecycle-authored scaffold, generated from the
// captured stack. Asserts the contract shape (a filled justfile + a stable ci.yml
// map), not a hardcoded toolchain. The SCAFFOLD BAR is structure + bootstrap/
// tier-1/build passing — a thorough test SUITE arrives with the feature specs.
export function buildScaffoldAcceptanceCriteria(lifecycle: CaptureLifecycle): string[] {
  return [
    `given an empty repo, when the scaffold lands, then a justfile fills the six conventional targets ` +
      `(bootstrap/tier-1/tier-2/tier-3/build/deploy) with the declared ${lifecycle.stack} commands — no STUB ` +
      `target remains (each runs the real command, not an "echo define <target>" placeholder)`,
    "given the justfile, when inspected, then `just bootstrap`, `just tier-1`, `just tier-2`, `just tier-3`, " +
      "`just build`, and `just deploy` each invoke the project's real stack command(s), human-runnable locally",
    "given the `.tanren/ci.yml`, when inspected, then it is a valid CiConfigV1 that maps the lifecycle to " +
      "`just <target>` (bootstrap → `just bootstrap`; fast/`per_iteration` → `just tier-1`; slow/`pre_audit` → " +
      "`just tier-2`; merge/`pre_merge` → `just tier-3`) — with NO stack commands inlined (the justfile is the " +
      "single source of the stack commands)",
    "given a tier that runs tests, when it runs, then it writes a machine-readable test report to a known path " +
      "(the test-report convention)",
    "given the scaffold, when `just bootstrap` then `just tier-1` and `just build` run, then each exits 0 " +
      "(structure + the fast/build tiers are green — a thorough test SUITE is NOT required at scaffold; tests " +
      "arrive with the feature specs)",
  ];
}
