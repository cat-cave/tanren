import type { SensitivityRule } from "./sensitivity.js";
import { auditEnvelopeSensitivityPaths } from "./schemas/audit.js";

// AUDIT-EVIDENCE + SECURITY-BASELINE sensitivity rules (tanren-direction.md §§
// "Audit And Compliance Baseline" + "Security Baseline").
//
// Two concerns live here so the audit model is taught in one place:
//   1. The shared AUDIT ENVELOPE (policy version + initiating/approving actor) every
//      governing event (gate.verdict / deploy.* / merge.completed) embeds. Every
//      envelope field is `public` — the envelope is non-secret BY CONSTRUCTION (an
//      actor is a kind + an opaque handle; a policy version is an integer). The
//      schema owns the path list (`auditEnvelopeSensitivityPaths`) so the tags here
//      cannot drift from the shape.
//   2. The `release.finalized` CLEANUP-PROOF event. A residual resource is a
//      NON-SECRET resource handle, so it is `public` too — never a credential.

/** The audit-envelope rules for one governing event (policy version + actors), all public. */
export function auditEnvelopeRulesFor(eventName: string): SensitivityRule[] {
  return auditEnvelopeSensitivityPaths().map(([path, tag]) => ({ eventName, path, tag }));
}

// The audit-baseline rules NOT covered by an envelope spread elsewhere: the
// `release.finalized` cleanup-proof + the `deploy.triggered` artifact ref. Both
// carry only non-secret resource handles / checksums + a non-secret failure summary.
export const auditBaselineSensitivityRules: SensitivityRule[] = [
  // Security-baseline cleanup-proof — the released runner id, the cleanup verdict,
  // the residual resource handles, and a non-secret failure summary. All public: a
  // resource handle is not a secret, and the release path emits no command output.
  { eventName: "release.finalized", path: "runnerId", tag: "public" },
  { eventName: "release.finalized", path: "cleanedUp", tag: "public" },
  { eventName: "release.finalized", path: "residualResources", tag: "public" },
  { eventName: "release.finalized", path: "residualResources[]", tag: "public" },
  { eventName: "release.finalized", path: "failureReason", tag: "public" },

  // deploy.triggered artifact (checksum + provenance ref): a content digest and a
  // build/image handle — non-secret provenance, never the artifact contents.
  { eventName: "deploy.triggered", path: "artifact.checksum", tag: "public" },
  { eventName: "deploy.triggered", path: "artifact.provenanceRef", tag: "public" },
];
