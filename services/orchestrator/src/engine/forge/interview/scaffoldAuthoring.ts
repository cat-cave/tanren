// Author the greenfield monorepo-scaffold spec FROM the captured lifecycle.
//
// The stack-flexible contract (docs/roadmap/stack-flexible-contract.md): Tanren
// knows NO stack. A project DECLARES its lifecycle in a `justfile` (the
// conventional targets `bootstrap`/`tier-1`/`tier-2`/`tier-3`/`build`/`deploy`
// hold the ACTUAL stack commands) + a stable, stack-agnostic `.tanren/ci.yml`
// that maps the lifecycle to `just <target>`.
//
// v27 FIX — the CONTRACT FILES ARE MATERIALIZED DETERMINISTICALLY, NOT LLM-AUTHORED.
// On apex v27 the LLM writer reliably mangled the `.tanren/ci.yml` YAML shape
// ("bootstrap expected object received string; tiers.* expected array received
// object; when expected record received undefined"): the writer was told to start
// from the skeleton by PATH, but the skeleton files don't exist in an empty
// greenfield repo, so it authored the ci.yml from scratch and got the structure
// wrong. The fix: the RUN path materializes both contract files MECHANICALLY from
// the captured lifecycle (engine/forge/scaffold/contractFiles.ts → the workspace-
// prep commits them before the writer runs) — the ci.yml VERBATIM (always parses
// through `resolveCiConfig`), the justfile filled from the lifecycle. So the
// writer's scaffold job NARROWS to the actual PROJECT CODE (package.json / src /
// manifests / …). It does NOT author the contract files — they are already
// committed when it starts.
//
// This still bakes in ZERO stack: the lifecycle table the writer is shown (so it
// authors code matching the declared toolchain) comes entirely from the captured
// `CaptureLifecycle`. A Rust capture yields cargo; a TS capture yields pnpm; a
// novel-translation capture yields pandoc — from the declaration, never Tanren's TS.

import { SKELETON_CI_CONFIG_PATH, SKELETON_JUSTFILE_PATH } from "../scaffold/index.js";
import type { CaptureLifecycle } from "./types.js";

// The conventional justfile targets, in lifecycle order, paired with the
// `CaptureLifecycle` field. Tanren's ONLY general knowledge: the target NAMES +
// tier→lifecycle semantics (the contract §4) — never the commands. The writer reads
// this table for CONTEXT (what each pre-committed target runs) so it authors
// matching project code; it does NOT fill the targets (they are materialized).
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
// reads for CONTEXT (each PRE-COMMITTED target's command), so it authors project
// code that those targets can actually run. PURE projection — no stack literal here.
function renderLifecycleTable(lifecycle: CaptureLifecycle): string {
  return CONVENTIONAL_TARGETS.map(({ target, field, semantics }) => {
    const command = lifecycle[field].trim();
    return `  - just ${target} (${semantics}):\n      ${command.replaceAll("\n", "\n      ")}`;
  }).join("\n");
}

// Build the `monorepo scaffold` spec description from the captured lifecycle. The
// CONTRACT FILES (`justfile` + `.tanren/ci.yml`) are MATERIALIZED DETERMINISTICALLY
// by the run before the writer starts — so the writer is instructed to author the
// PROJECT CODE/structure that the (already-committed) lifecycle targets run, and to
// LEAVE THE CONTRACT FILES ALONE. NO hardcoded stack: the commands shown are the
// project's own declaration.
export function buildScaffoldDescription(lifecycle: CaptureLifecycle): string {
  return [
    `Scaffold the actual PROJECT CODE for the chosen stack — ${lifecycle.stack}. The contract files are ` +
      `ALREADY COMMITTED for you (materialized deterministically): \`${SKELETON_JUSTFILE_PATH}\` (the six ` +
      `conventional targets bootstrap/tier-1/tier-2/tier-3/build/deploy, filled with the lifecycle commands ` +
      `below) and \`${SKELETON_CI_CONFIG_PATH}\` (the stable lifecycle→\`just <target>\` map). Do NOT author, ` +
      "re-write, or re-define either contract file — they are correct and final; edit ONLY the project code.",
    "",
    "The pre-committed justfile targets run these commands — author the project structure (dependency " +
      "manifests/lockfiles, a minimal source entrypoint, config) so EACH target can actually run:",
    renderLifecycleTable(lifecycle),
    "",
    "Make the scaffold real for this stack — real dependency manifests/lockfiles, a minimal source entrypoint, " +
      "and a committed ignore file for build/install/report artifacts — NOT stubs or placeholders. A tier that " +
      "runs tests writes a machine-readable test report to a known path (the test-report convention) so " +
      "flaky-intelligence ingests it; ensure your code/config honours that. Do NOT invent a stack: the stack and " +
      "every command above come from the architecture step's lifecycle declaration.",
  ].join("\n");
}

// The acceptance criteria for the scaffold. The contract files (justfile + ci.yml)
// are materialized deterministically (asserted in unit tests + always parse through
// `resolveCiConfig`), so the criteria here assert the WRITER's narrowed job: real
// project code for the declared stack that the pre-committed targets can run. The
// SCAFFOLD BAR is structure + bootstrap/tier-1/build passing — a thorough test SUITE
// arrives with the feature specs.
export function buildScaffoldAcceptanceCriteria(lifecycle: CaptureLifecycle): string[] {
  return [
    `given an empty repo, when the scaffold lands, then real ${lifecycle.stack} project code exists ` +
      "(dependency manifests/lockfiles, a minimal source entrypoint, config) — NOT stubs or placeholders",
    `given the pre-committed contract files, when the scaffold lands, then the writer left \`${SKELETON_JUSTFILE_PATH}\` ` +
      `and \`${SKELETON_CI_CONFIG_PATH}\` intact (they are materialized deterministically — the writer authors ` +
      "project code, never the contract files)",
    "given the scaffolded code, when `just bootstrap`, `just tier-1`, and `just build` run, then each exits 0 " +
      "(structure + the fast/build tiers are green against the project's own code — a thorough test SUITE is NOT " +
      "required at scaffold; tests arrive with the feature specs)",
    "given a tier that runs tests, when it runs, then the project's code/config writes a machine-readable test " +
      "report to a known path (the test-report convention)",
  ];
}
