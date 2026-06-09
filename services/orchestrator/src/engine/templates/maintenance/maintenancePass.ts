// The MAINTENANCE PASS (docs/roadmap/templating-system.md §4) — one re-validation
// of one registered template. It RE-RUNS the full validation harness over the
// template repo (the SAME `runValidationHarness` the creation flow proved it with —
// it does NOT reinvent validation) and decides the registry outcome:
//
//   - GREEN (the proof validates):    refresh `validationProof` + `validatedAt` on
//                                      the manifest → status `validated`. No finding.
//   - RED  (the proof FAILS to validate): the template regressed — an upstream bump
//                                      broke a gate, or a negative control went
//                                      unproven. Mark `degraded` (selection stops
//                                      choosing it) AND file a finding so the
//                                      breakage re-enters the DAG (same hand-off a
//                                      scheduled audit uses) — Tanren fixes it as a
//                                      real unit of work, never hand-patches.
//
// FAIL-CLOSED is the whole contract: a maintenance pass NEVER silently ships a
// broken template. A regression degrades + files a finding; the harness/store
// THROWING propagates LOUDLY (the loop logs + retries) rather than recording a
// false-green. Clock is INJECTED (no Date.now). This module is PURE-of-IO except
// the harness + store calls it is handed.

import { templateValidates } from "../validationProof.js";
import type { TemplateManifestV1, TemplateValidationProof } from "../manifest.js";
import type { AuditFinding } from "../../forge/audits/types.js";

// The outcome of re-validating one template. `proof` is the freshly-produced harness
// proof; `validated` is its verdict; `findings` is the regression finding(s) to route
// (empty when green). `nextManifest` is the manifest with the refreshed proof, ready
// for `updateManifest`.
export interface MaintenancePassOutcome {
  proof: TemplateValidationProof;
  validated: boolean;
  nextManifest: TemplateManifestV1;
  findings: AuditFinding[];
}

// The harness seam: re-run the full validation harness over a template's repo and
// return the proof. Injected so the maintenance pass is testable without a live
// runner (tests pass a scripted harness) and so production wires the REAL
// `runValidationHarness` (over an allocated runner + the resolved CI config). A
// throw propagates LOUDLY — a harness that cannot run is never a silent green.
export interface TemplateRevalidator {
  revalidate(input: { template: MaintainableTemplate }): Promise<TemplateValidationProof>;
}

// The minimal template shape the maintenance pass reads (a subset of the registry
// `Template` row): its id, its parsed manifest. The store row carries more (org,
// repoRef, status); the pass needs only these to produce the next manifest + finding.
export interface MaintainableTemplate {
  id: string;
  orgId: string;
  repoRef: string;
  manifest: TemplateManifestV1;
}

// Build the regression finding a RED re-validation files. `externalId` is STABLE per
// template (so re-running maintenance upserts the SAME candidate — idempotent in the
// inbox on (source_id, external_id), never a duplicate finding per pass). Severity
// `fail` (a broken gate is blocking — it maps to a P0/P1 routed spec). The body
// carries the per-gate proof so the fixing agent sees exactly which control regressed.
export function regressionFinding(template: MaintainableTemplate, proof: TemplateValidationProof): AuditFinding {
  const nc = proof.negativeControls;
  const unproven = (Object.keys(nc) as (keyof typeof nc)[]).filter((k) => nc[k] === "unproven");
  const lines = [
    `Template \`${template.manifest.stack}\` (${template.repoRef}, channel ${template.manifest.channel}) FAILED re-validation.`,
    "",
    `- positive controls: ${proof.positiveControlsPassed ? "passed" : "FAILED"}`,
    `- auditor clean: ${proof.auditorClean ? "yes" : "NO (open P0/P1)"}`,
    unproven.length > 0
      ? `- negative controls UNPROVEN (gate no longer catches a planted defect): ${unproven.join(", ")}`
      : "- negative controls: all declared controls proven",
    "",
    "An upstream bump or environment change regressed this template's gates. Restore the",
    "template to a state where the full validation harness is green (positive controls pass,",
    "every declared negative control proven, auditor clean), then re-register the proof.",
  ];
  return {
    externalId: `template-maintenance:${template.id}`,
    title: `Template ${template.manifest.stack} regressed re-validation`,
    body: lines.join("\n"),
    severity: "fail",
  };
}

/**
 * Re-validate ONE template: run the harness, compute the verdict, and produce the
 * outcome (refreshed proof + manifest + any regression finding). PURE-of-the-store —
 * the caller (the loop) persists the manifest / status and routes the findings. A
 * GREEN proof yields no finding; a RED proof yields exactly one stable-keyed
 * regression finding. Clock flows through the harness (it stamps `validatedAt`).
 */
export async function runMaintenancePass(
  revalidator: TemplateRevalidator,
  template: MaintainableTemplate,
): Promise<MaintenancePassOutcome> {
  const proof = await revalidator.revalidate({ template });
  const validated = templateValidates(proof);
  const nextManifest: TemplateManifestV1 = { ...template.manifest, validationProof: proof };
  const findings = validated ? [] : [regressionFinding(template, proof)];
  return { proof, validated, nextManifest, findings };
}
