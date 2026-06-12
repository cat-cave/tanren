// DETERMINISTIC contract-file materialization — the v27 fix.
//
// The bug found live on apex v27: the scaffold's contract files (`.tanren/ci.yml`
// + `justfile`) were authored by the LLM WRITER, which reliably mangled the ci.yml
// YAML shape (live gate error: "invalid tanren-ci.yml: bootstrap expected object
// received string; tiers.* expected array received object; when expected record
// received undefined"). The writer was INSTRUCTED to start from the skeleton by
// PATH, but the skeleton files don't exist in an empty greenfield repo, so it
// authored the ci.yml from scratch and got the structure wrong.
//
// NEITHER contract file needs LLM authoring — they are MECHANICAL:
//   - `.tanren/ci.yml` is a STABLE, stack-agnostic `just`-map (tiers as arrays,
//     bootstrap as an object, a separate `when` record). It is IDENTICAL for every
//     project — it is `SKELETON_CI_CONFIG` VERBATIM.
//   - `justfile` is the six conventional targets (bootstrap / tier-1 / tier-2 /
//     tier-3 / build / deploy) filled from the captured `ProjectLifecycle` — a pure
//     string projection of the lifecycle, with NO stack assumption (a Rust/cargo or
//     novel/pandoc lifecycle fills the same six targets just as naturally).
//
// This module is that deterministic projection: given a `ProjectLifecycle`, it
// produces the exact bytes of both contract files. The RUN path materializes them
// into the workspace verbatim BEFORE the writer runs (plannerRunWorkspace.ts), so
// the committed `.tanren/ci.yml` ALWAYS parses through `resolveCiConfig` (it is the
// skeleton verbatim) and the justfile ALWAYS has the six targets with the lifecycle
// commands — regardless of LLM behavior. The writer's scaffold job narrows to the
// actual PROJECT CODE (package.json / src / …); it never touches the contract files.

import type { ProjectLifecycle } from "../../config/index.js";
import {
  SKELETON_CI_CONFIG,
  SKELETON_CI_CONFIG_PATH,
  SKELETON_JUSTFILE_PATH,
  SKELETON_MISE_CONFIG_PATH,
  renderJustfile,
  renderMiseToml,
  stubRecipeBody,
} from "./skeleton.js";

// One file the materialization writes into the workspace verbatim (path + exact
// bytes). The RUN path commits these before the writer authors any code.
export interface ContractFile {
  readonly path: string;
  readonly content: string;
}

// The conventional justfile targets, in lifecycle order, paired with the
// `ProjectLifecycle` field that fills each. Tanren's ONLY general knowledge: the
// target NAMES + their lifecycle order — never the commands (those are the
// project's declaration). Mirrors the interview's CONVENTIONAL_TARGETS so the
// filled justfile matches the captured lifecycle 1:1.
const TARGET_FIELDS: ReadonlyArray<{
  readonly target: string;
  readonly field: keyof Omit<ProjectLifecycle, "stack" | "toolchain">;
}> = [
  { target: "bootstrap", field: "bootstrap" },
  { target: "tier-1", field: "tier1" },
  { target: "tier-2", field: "tier2" },
  { target: "tier-3", field: "tier3" },
  { target: "build", field: "build" },
  { target: "deploy", field: "deploy" },
  // The `upgrade` verb (environment-management.md §4.5/§7 P1) — bumps deps to latest.
  // The command is the project's declaration (may be "" ⇒ a STUB target that fails
  // loudly, so an un-declared upgrade can never silently no-op a version-change node).
  { target: "upgrade", field: "upgrade" },
] as const;

// Render one justfile recipe BODY from a captured command. just requires every
// recipe line to start with a TAB (not spaces) — a multi-line command
// (newline-joined in the capture) becomes one tab-indented line PER command line,
// so each runs as its own recipe step. NO stack literal appears here: the command
// is the project's own declaration, passed through verbatim.
function recipeBody(command: string): string {
  return command
    .split("\n")
    .map((line) => `\t${line}`)
    .join("\n");
}

// Project a captured `ProjectLifecycle` onto the filled `justfile` — the skeleton's
// six conventional targets, each STUB replaced by the captured command. A pure
// string projection: the SAME `renderJustfile` shape the stub skeleton uses, so the
// filled justfile can never drift from the contract shape. Stack-AGNOSTIC: a cargo
// or pandoc lifecycle fills the targets identically to a pnpm one.
export function renderLifecycleJustfile(lifecycle: ProjectLifecycle): string {
  // `?? ""` defends the OPTIONAL `upgrade` verb: the parsed `ProjectLifecycle` always
  // carries it (default ""), but a lifecycle assembled WITHOUT going through the schema
  // (e.g. a partial fixture) may omit it — treat a missing command as "" (→ STUB), never
  // a crash.
  const byTarget = new Map(TARGET_FIELDS.map(({ target, field }) => [target, (lifecycle[field] ?? "").trim()]));
  // An UNFILLED target (an optional verb the project declared no command for, e.g.
  // `upgrade=""` on a pure-shell stack) renders the LOUD STUB (`exit 1`), never an
  // empty recipe that would silently pass the gate — so an un-declared `just upgrade`
  // cannot make a version-change node a silent no-op.
  return renderJustfile((target) => {
    const command = byTarget.get(target) ?? "";
    return command === "" ? stubRecipeBody(target) : recipeBody(command);
  });
}

// The deterministic contract-file manifest for a project's lifecycle: the
// stack-agnostic `.tanren/ci.yml` (SKELETON_CI_CONFIG VERBATIM — the correct-shape
// `just`-map, never LLM-authored) + the lifecycle-FILLED `justfile` + (when the
// project declared a toolchain) a `mise.toml` rendered from the toolchain list. The
// RUN path writes these into the workspace exactly as returned, before the writer
// runs. The `mise.toml` is a DETERMINISTIC projection (like the justfile) — NEVER
// LLM-authored; an EMPTY/absent toolchain materializes NO mise.toml (a project may
// legitimately declare none and provision inside its own bootstrap shell — Tanren
// invents no versions).
export function materializeContractFiles(lifecycle: ProjectLifecycle): ContractFile[] {
  const files: ContractFile[] = [
    { path: SKELETON_CI_CONFIG_PATH, content: SKELETON_CI_CONFIG },
    { path: SKELETON_JUSTFILE_PATH, content: renderLifecycleJustfile(lifecycle) },
  ];
  if (lifecycle.toolchain.length > 0) {
    files.push({ path: SKELETON_MISE_CONFIG_PATH, content: renderMiseToml(lifecycle.toolchain) });
  }
  return files;
}
