// MATRIX-HIT MATERIALIZATION (PR-C; templating-system.md §FRAGMENTS).
//
// Split out of `derive.ts` for file-size discipline. On a `compose-from-fragments`
// decision (the curated registry matched the operator's stack), the derive calls
// `materializeIfComposeFromFragments` BEFORE the scaffold spec authoring runs:
// the materializer seam assembles the VFS, creates a fresh template repo, pushes
// the composed files, and returns a `SelectedTemplate`. We substitute a `strong`
// seed decision back so the rest of derive (`scaffoldSpecsFor`, `assertSeeded`,
// `templateRefConfig`) reads it through the SAME code-path an org-registry hit
// takes. All other decision shapes pass through unchanged.

import type { MaterializeCuratedTemplate } from "../../templates/fragments/index.js";
import type { ScaffoldOrigin } from "./interviewTemplateGate.js";
import type { TemplateSelectionDecision } from "./templateSelection.js";
import type { CaptureLifecycle } from "./types.js";

// Re-export the materializer type so `derive.ts` consolidates its template-fragments
// import through this barrel (one fewer dependency line in derive.ts).
export type { MaterializeCuratedTemplate } from "../../templates/fragments/index.js";

// The thin slice of DeriveInput the matrix-hit step reads — kept structurally typed
// so this module never re-imports `DeriveInput` (avoids a cycle).
export interface MatrixHitInput {
  owner?: string;
  materializeCuratedTemplate?: MaterializeCuratedTemplate;
}

/**
 * The seed reference persisted onto the project config when a template was selected
 * (strong/partial). `{}` when none/blocked/skipped — the from-scratch path. Extracted
 * with the matrix-hit helper so derive.ts stays under the per-file line cap.
 */
export function templateRefConfig(decision: TemplateSelectionDecision | undefined): {
  templateRef?: Record<string, string>;
} {
  if (decision?.selected === undefined) return {};
  if (decision.kind !== "strong" && decision.kind !== "partial") return {};
  const sel = decision.selected;
  return {
    templateRef: {
      templateRef: sel.templateRef,
      repoRef: sel.repoRef,
      validatedAt: sel.validationProof.validatedAt,
      validatedSha: sel.validationProof.validatedSha,
    },
  };
}

/**
 * If `decision` is a `compose-from-fragments` matrix-hit, invoke the materializer
 * seam and return a `strong` seed substitution. Otherwise pass the decision through
 * unchanged.
 *
 * A matrix-hit decision with NO materializer wired throws LOUD — that path requires
 * the materializer (production wires it in mountFeatureRoutes); absent on a
 * project-origin derive is a wiring bug, not a "skip the matrix" signal.
 */
export async function materializeIfComposeFromFragments(
  decision: TemplateSelectionDecision | undefined,
  lifecycle: CaptureLifecycle,
  input: MatrixHitInput,
  scaffoldOrigin: ScaffoldOrigin,
): Promise<TemplateSelectionDecision | undefined> {
  if (decision === undefined || decision.kind !== "compose-from-fragments") return decision;
  if (decision.curated === undefined) {
    throw new Error(
      "INVARIANT VIOLATION: a compose-from-fragments decision lacks its `curated` payload — " +
        "the selection layer must always attach it (this is a programming error in selectSeedTemplate).",
    );
  }
  if (input.materializeCuratedTemplate === undefined) {
    throw new Error(
      `compose-from-fragments decision for curated entry "${decision.curated.id}" but NO ` +
        `materializeCuratedTemplate seam wired. The matrix-hit path requires the materializer ` +
        `(production wires it in mountFeatureRoutes); absent on a project-origin derive is a wiring bug.`,
    );
  }
  if (scaffoldOrigin !== "project") {
    // Defensive: the curated lookup runs only on "project" (see selectSeedTemplate),
    // so this branch is unreachable today; if it ever fires, that is a bug.
    throw new Error(
      `compose-from-fragments decision on scaffoldOrigin "${scaffoldOrigin}" — matrix-hit ` +
        `routing is project-only (the template_build origin authors its template from scratch).`,
    );
  }
  if (input.owner === undefined) {
    throw new Error(
      `matrix-hit materialization requires a GitHub owner for the template repo, but ` +
        `DeriveInput.owner is absent. The greenfield derive always supplies it; a missing ` +
        `owner here is a wiring bug.`,
    );
  }
  const selected = await input.materializeCuratedTemplate({
    curated: decision.curated,
    lifecycle,
    owner: input.owner,
  });
  // Substitute a STRONG seed decision so the rest of derive (scaffoldSpecsFor +
  // assertSeeded + templateRefConfig) reads it through the same code-path the
  // org-registry hit takes. Preserve the original reasons so the audit trail keeps
  // the `matrix-hit:<id>` provenance.
  return {
    kind: "strong",
    selected,
    query: decision.query,
    reasons: [...decision.reasons, "materialized"],
  };
}
