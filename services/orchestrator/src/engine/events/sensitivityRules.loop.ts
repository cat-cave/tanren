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
  ]),
  ...rulesFor("convergence.started", [["taskKind", "public"]]),
  ...rulesFor("convergence.assessed", [
    ["runId", "public"],
    ["taskId", "public"],
    ["assessment", "public"],
    ["decision", "public"],
    ["consecutiveStalls", "public"],
    ["maxConsecutiveStalls", "public"],
    ["reasoning", "public"],
  ]),
  ...rulesFor("convergence.stalled", [
    ["runId", "public"],
    ["consecutiveStalls", "public"],
    ["maxConsecutiveStalls", "public"],
    ["reason", "public"],
  ]),
];
