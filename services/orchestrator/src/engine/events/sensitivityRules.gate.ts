import type { SensitivityRule } from "./sensitivity.js";
import { auditEnvelopeRulesFor } from "./sensitivityRules.audit.js";

// Native in-loop gate sensitivity rules, split out of sensitivityRules.ts to keep
// each file under the 500-line cap. The gate is the native delivery model's merge
// authority: it runs the repo's tiered shell steps over SSH and judges pass/fail
// from exit codes. Tier/step names + exit codes are public identifiers; a captured
// command output TAIL carries stdout/stderr, which the taxonomy treats as secret
// (it may surface env values or paths). The `gate.verdict` roll-up carries no
// output tail, so every field on it is public.
export const gateSensitivityRules: SensitivityRule[] = [
  ...rulesFor("gate.started", [
    ["tier", "public"],
    ["when", "public"],
    ["stepNames", "public"],
    ["stepNames[]", "public"],
  ]),
  ...rulesFor("gate.passed", [
    ["tier", "public"],
    ["when", "public"],
    ["steps[].name", "public"],
    ["steps[].run", "public"],
    ["steps[].exitCode", "public"],
    ["steps[].passed", "public"],
    ["steps[].timedOut", "public"],
    ["steps[].outputTail", "secret"],
    // Evidence verdict (task #64) is a metric: counts / required thresholds, no secret
    // surface — observed/required carry numeric totals + the declared path/pattern (a
    // public CI-config field), not stdout/stderr (which is already in `outputTail`).
    ["steps[].evidence.kind", "public"],
    ["steps[].evidence.sufficient", "public"],
    ["steps[].evidence.reason", "public"],
    ["steps[].evidence.observed", "public"],
    ["steps[].evidence.required", "public"],
  ]),
  ...rulesFor("gate.failed", [
    ["tier", "public"],
    ["when", "public"],
    ["failedStep", "public"],
    ["exitCode", "public"],
    ["failedReason", "public"],
    ["steps[].name", "public"],
    ["steps[].run", "public"],
    ["steps[].exitCode", "public"],
    ["steps[].passed", "public"],
    ["steps[].timedOut", "public"],
    ["steps[].outputTail", "secret"],
    ["steps[].evidence.kind", "public"],
    ["steps[].evidence.sufficient", "public"],
    ["steps[].evidence.reason", "public"],
    ["steps[].evidence.observed", "public"],
    ["steps[].evidence.required", "public"],
    // Top-level evidence on the gate.failed payload: the harvested verdict for the
    // failing step (the diagnosis the writer's rework directive consumes).
    ["evidence.kind", "public"],
    ["evidence.sufficient", "public"],
    ["evidence.reason", "public"],
    ["evidence.observed", "public"],
    ["evidence.required", "public"],
  ]),
  // Lenient-posture advisory step failure (lint/typecheck): names + exit code are
  // public identifiers; the captured output tail is secret (may surface env/paths).
  ...rulesFor("gate.advisory_failed", [
    ["tier", "public"],
    ["when", "public"],
    ["advisoryStep", "public"],
    ["exitCode", "public"],
    ["outputTail", "secret"],
  ]),
  // A flaky-quarantine step exclusion: a proven-flaky step failed but was excluded
  // from the verdict (surface-driven, every posture). Names + exit code are public
  // identifiers; the captured output tail is secret (may surface env/paths).
  ...rulesFor("gate.quarantine_excluded", [
    ["tier", "public"],
    ["when", "public"],
    ["quarantinedStep", "public"],
    ["exitCode", "public"],
    ["outputTail", "secret"],
  ]),
  // A forge-publish failure of an already-decided verdict (non-fatal): the lifecycle
  // point, commit, decided verdict, and the non-secret reason (HTTP status / error
  // class — the token is never in it) are all public diagnostics.
  ...rulesFor("gate.publish_failed", [
    ["when", "public"],
    ["headSha", "public"],
    ["passed", "public"],
    ["reason", "public"],
  ]),
  // The native gate verdict roll-up: the commit, lifecycle point, combined verdict,
  // timing, tier list, and the flattened per-step names+outcomes are all public
  // identifiers/metrics (it carries NO command output tail — no secret surface).
  ...rulesFor("gate.verdict", [
    ["when", "public"],
    ["headSha", "public"],
    ["passed", "public"],
    ["durationMs", "public"],
    ["tiers", "public"],
    ["tiers[]", "public"],
    ["steps[].name", "public"],
    ["steps[].tier", "public"],
    ["steps[].passed", "public"],
    ["failedTier", "public"],
    ["failedStep", "public"],
  ]),
  // AUDIT ENVELOPE on the gate verdict: policy version + initiating/approving actor,
  // all public (non-secret by construction). The gate is the merge authority, so its
  // verdict is a governing event that must carry the audit-evidence fields.
  ...auditEnvelopeRulesFor("gate.verdict"),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
