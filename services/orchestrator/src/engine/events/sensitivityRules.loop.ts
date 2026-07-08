import type { SensitivityRule } from "./sensitivity.js";

// SPEC-LOOP REDESIGN sensitivity rules (docs/roadmap/spec-loop-redesign.md): the new
// per-spec stage events — demo-run, triage, convergence. All public: findings,
// work-items, and convergence reads are product-quality narration (a finding id /
// severity / title becomes a real visible spec or task), never a secret. Lives in this
// split so the main sensitivityRules.ts stays under the 500-line architecture cap.

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}

export const specLoopStageSensitivityRules: SensitivityRule[] = [
  // SPEC-LOOP REDESIGN: the checker emits completeness findings (no binary passed); the
  // auditor is findings-only (no passed/recommendedAction). The findings list IS the
  // verdict — public, since each becomes a real task / DAG spec, never a secret.
  ...rulesFor("checker.verdict", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["complete", "public"],
    ["reasoning", "public"],
    ["behaviorIdsFailed", "public"],
    ["behaviorIdsFailed[]", "public"],
    ["findings", "public"],
    ["findings[].id", "public"],
    ["findings[].title", "public"],
    ["findings[].body", "public"],
    ["findings[].behaviorId", "public"],
    // EMPTY-INCREMENTAL-DIFF (v35): the deterministic empty-`baselineSha → HEAD`-diff
    // fact — product-quality narration (an empty-diff accept / non-reworkable reject is
    // auditable), never a secret.
    ["emptyIncrementalDiff", "public"],
  ]),
  // §3.1: the deterministic entity-change risk signal — all structural metadata
  // (class / provenance / counts / rationale), product-quality narration, no secret.
  ...rulesFor("checker.entity_risk", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["riskClass", "public"],
    ["provenance", "public"],
    ["unexpectedFailure", "public"],
    ["scrutiny", "public"],
    ["rationale", "public"],
    ["counts", "public"],
    ["counts.total", "public"],
    ["counts.cosmetic", "public"],
    ["counts.structural", "public"],
    ["counts.publicSignature", "public"],
    ["counts.deletedOrRenamed", "public"],
  ]),
  ...rulesFor("auditor.verdict", [
    ["runId", "public"],
    ["findings", "public"],
    ["findings[].id", "public"],
    ["findings[].severity", "public"],
    ["findings[].title", "public"],
    ["findings[].body", "public"],
    ["findings[].fixHint", "public"],
  ]),
  ...rulesFor("demoRun.started", [["taskKind", "public"]]),
  ...rulesFor("demoRun.verdict", [
    ["runId", "public"],
    ["summary", "public"],
    ["findings", "public"],
    ["findings[].id", "public"],
    ["findings[].severity", "public"],
    ["findings[].title", "public"],
    ["findings[].body", "public"],
    ["findings[].fixHint", "public"],
  ]),
  ...rulesFor("designOracle.started", [["taskKind", "public"]]),
  ...rulesFor("designOracle.verdict", [
    ["runId", "public"],
    ["contractVersion", "public"],
    ["verificationMode", "public"],
    ["summary", "public"],
    ["findings", "public"],
    ["findings[].id", "public"],
    ["findings[].severity", "public"],
    ["findings[].title", "public"],
    ["findings[].body", "public"],
    ["findings[].fixHint", "public"],
  ]),
  ...rulesFor("triage.started", [["taskKind", "public"]]),
  ...rulesFor("triage.completed", [
    ["runId", "public"],
    ["taskId", "public"],
    ["outcome", "public"],
    ["items", "public"],
    ["items[].id", "public"],
    ["items[].kind", "public"],
    ["items[].route", "public"],
    ["items[].severity", "public"],
    ["items[].title", "public"],
    ["items[].findingIds", "public"],
    ["items[].findingIds[]", "public"],
    ["droppedSpecs", "public"],
    ["droppedSpecs[].id", "public"],
    ["droppedSpecs[].title", "public"],
    ["droppedSpecs[].severity", "public"],
    ["droppedSpecs[].reason", "public"],
  ]),
  ...rulesFor("convergence.started", [["taskKind", "public"]]),
  ...rulesFor("convergence.assessed", [
    ["runId", "public"],
    ["taskId", "public"],
    ["assessment", "public"],
    ["blockingRootCauseProgress", "public"],
    ["blockingRootCauseId", "public"],
    ["escalation", "public"],
    ["decision", "public"],
    ["consecutiveStalls", "public"],
    ["reasoning", "public"],
  ]),
  ...rulesFor("convergence.stalled", [
    ["runId", "public"],
    ["consecutiveStalls", "public"],
    ["reason", "public"],
  ]),
  // §3.3 entity-anchored Claims (the Tanren-native defect ledger). All fields are
  // product-quality narration — entity identity (a structural hash / name) + a
  // defect provenance link + a rationale — never secret-bearing.
  ...rulesFor("forge.claim.anchored", [
    ["claimId", "public"],
    ["orgId", "public"],
    ["projectId", "public"],
    ["candidateId", "public"],
    ["entityId", "public"],
    ["entityKind", "public"],
    ["entityName", "public"],
  ]),
  ...rulesFor("forge.claim.self_resolved", [
    ["claimId", "public"],
    ["orgId", "public"],
    ["projectId", "public"],
    ["entityId", "public"],
    ["entityName", "public"],
    ["decidability", "public"],
    ["rationale", "public"],
  ]),
  ...rulesFor("forge.claim.validated", [
    ["claimId", "public"],
    ["orgId", "public"],
    ["projectId", "public"],
    ["entityId", "public"],
    ["probeStatus", "public"],
    ["decidability", "public"],
    ["unexpectedUnavailable", "public"],
    ["rationale", "public"],
  ]),
];
