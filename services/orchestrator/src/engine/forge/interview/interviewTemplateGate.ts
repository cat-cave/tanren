// The PROJECT-vs-TEMPLATE-BUILD scaffold gate (templating-system.md §3) — the single
// enforcement point of the doctrine: every PROJECT DAG executes against a VALIDATED
// TEMPLATE, never a from-scratch scaffold. Split out of `derive.ts` (file-size
// discipline) so the derive reads as "select-seed → author specs" with the invariant
// machinery factored here.
//
// The `scaffoldOrigin` discriminator:
//   - "project" (greenfield onboarding + greenfield create): selection ALWAYS runs
//     (`templateRegistryQuery` REQUIRED). A match SEEDS; a no-match CREATES a validated
//     template JUST-IN-TIME + seeds from it; an un-creatable no-match HALTS LOUD
//     (`TemplateRequiredError`, inside `selectTemplate`). The from-scratch authoring is
//     UNREACHABLE on this path (`assertSeeded` asserts it after selection).
//   - "template_build": the BUILD step of template-creation — it authors the TEMPLATE
//     itself from scratch (the ONE legitimate from-scratch authoring). No selection;
//     the result is VALIDATED (negative controls) before any project seeds from it.

import {
  SEEDABLE_STATUSES,
  selectTemplate,
  type SelectedTemplate,
  type TemplateRegistryQuery,
  type TemplateSelectionDecision,
} from "./templateSelection.js";
import { lookupCurated } from "../../templates/fragments/registry/index.js";
import type { CaptureLifecycle } from "./types.js";

export type ScaffoldOrigin = "project" | "template_build";

// Convenience re-exports for the derive — the gate is already its single "templating"
// import surface (it re-exports `TemplateRegistryQueryRequiredError` for the same
// reason). Lets derive.ts stay under the per-file import-dependency cap without an
// extra `templateSelection.js` import line.
export type { SelectedTemplate, TemplateRegistryQuery, TemplateSelectionDecision } from "./templateSelection.js";
// PR-C — the matrix-hit materializer helpers re-exported through the gate so derive.ts
// imports them on the SAME line it imports the gate's own seeds (one fewer dependency
// line; the gate is already derive's single templating import surface).
export {
  materializeIfComposeFromFragments,
  templateRefConfig,
  type MaterializeCuratedTemplate,
} from "./deriveMatrixHit.js";

// Thrown when a "project" scaffoldOrigin derive was wired WITHOUT a template registry
// query — the bug that would let a project skip selection and scaffold from-scratch
// (the deleted bypass). The project path ALWAYS runs selection; the registry query is
// REQUIRED, never an opt-in. A LOUD wiring failure, not a degrade.
export class TemplateRegistryQueryRequiredError extends Error {
  constructor() {
    super(
      "project onboarding requires a template registry query — every project DAG selects a validated " +
        "template (seed or just-in-time-create); a project NEVER scaffolds from-scratch. The registry query " +
        "is ALWAYS provided on the project path (the mount wires it org-scoped). Its absence is a wiring bug.",
    );
    this.name = "TemplateRegistryQueryRequiredError";
  }
}

// The inputs the gate needs from the derive (a thin slice of `DeriveInput`).
export interface SelectSeedInput {
  scaffoldOrigin: ScaffoldOrigin;
  lifecycle: CaptureLifecycle;
  templateRegistryQuery?: TemplateRegistryQuery;
  templateChannelPreference?: "lts" | "nightly";
  selectionNow?: number;
  createTemplateForNoMatch?: (lifecycle: CaptureLifecycle) => Promise<SelectedTemplate | undefined>;
}

// Run the scaffold-origin guards + (for the project path) the template SELECTION. On
// "project" the result is ALWAYS a seed decision — a no-match has already thrown
// `TemplateRequiredError` inside `selectTemplate` (fail-closed halt, no from-scratch).
// On "template_build" no selection runs (returns `undefined`) — that derive IS the
// from-scratch authoring of the template itself.
//
// MATRIX-HIT ROUTING (PR-C). The CURATED-template registry is consulted FIRST (a pure,
// in-process lookup over the operator's `lifecycle.stack` label, canonicalized). A hit
// short-circuits with a `compose-from-fragments` decision (the new variant) — the
// derive's materializer assembles the template from typed fragments deterministically
// and skips the agent template-build path. A miss falls through to the existing
// registry-driven `selectTemplate`. On the template_build origin (which authors a
// template from scratch — there is nothing to select) the matrix check is skipped too
// (a curated hit there would wrongly recurse into composition).
export async function selectSeedTemplate(input: SelectSeedInput): Promise<TemplateSelectionDecision | undefined> {
  // MATRIX-HIT first (PR-C) — cheap, in-process, no IO. Only on the "project" origin
  // (the template_build origin is itself the from-scratch authoring of a template).
  if (input.scaffoldOrigin === "project") {
    const curated = lookupCurated(input.lifecycle.stack);
    if (curated !== undefined) {
      return {
        kind: "compose-from-fragments",
        curated,
        // No registry query was needed — record the seedable-statuses base for
        // observability so the decision row keeps the same shape as the strong/partial
        // path (a downstream consumer that reads `query` expects an object).
        query: { statuses: SEEDABLE_STATUSES },
        reasons: [`matrix-hit:${curated.id}`],
      };
    }
  }
  if (input.scaffoldOrigin === "project" && input.templateRegistryQuery === undefined) {
    // A project that did not run selection would scaffold from-scratch — the exact
    // bypass this doctrine deletes. The registry query is ALWAYS provided on the
    // project path; its absence is a wiring bug, not a "skip selection" signal.
    throw new TemplateRegistryQueryRequiredError();
  }
  if (input.scaffoldOrigin === "template_build" && input.templateRegistryQuery !== undefined) {
    // The template-BUILD derive authors the template FROM SCRATCH (it has nothing to
    // select); a registry query here would wrongly recurse into selection.
    throw new Error(
      "template_build scaffoldOrigin must not be given a templateRegistryQuery (it authors from scratch)",
    );
  }
  if (input.scaffoldOrigin === "template_build" || input.templateRegistryQuery === undefined) {
    return undefined;
  }
  return selectTemplate({
    lifecycle: input.lifecycle,
    registryQuery: input.templateRegistryQuery,
    actor: { kind: "operator" },
    ...(input.templateChannelPreference === undefined ? {} : { channelPreference: input.templateChannelPreference }),
    ...(input.selectionNow === undefined ? {} : { now: input.selectionNow }),
    ...(input.createTemplateForNoMatch === undefined ? {} : { createForNoMatch: input.createTemplateForNoMatch }),
  });
}

// THE NO-NON-TEMPLATE-DAG INVARIANT GUARD (templating-system.md §3). Asserts a
// "project" origin derive ALWAYS reached a template SEED (strong/partial) — i.e. the
// scaffold spec is the SHRUNKEN seed authoring, never the from-scratch authoring. By
// the time this runs, a no-match project path has ALREADY thrown `TemplateRequiredError`
// (inside `selectTemplate`), so a missing/non-seed selection here means a from-scratch
// project scaffold leaked through — a hard invariant violation, fail LOUD. The
// "template_build" origin is the ONE legitimate from-scratch authoring.
export function assertSeeded(scaffoldOrigin: ScaffoldOrigin, decision: TemplateSelectionDecision | undefined): void {
  if (scaffoldOrigin === "template_build") return;
  const seeded = decision?.selected !== undefined && (decision.kind === "strong" || decision.kind === "partial");
  if (!seeded) {
    throw new Error(
      "INVARIANT VIOLATION: a project-origin scaffold reached the from-scratch authoring path " +
        "(no validated template seed). A project DAG must NEVER scaffold against a non-template base — " +
        "a no-match must create-or-halt, never degrade to from-scratch. This is a fail-closed bug.",
    );
  }
}
