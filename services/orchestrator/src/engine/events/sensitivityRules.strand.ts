import type { SensitivityRule } from "./sensitivity.js";

// NEVER-STRAND reconciler sensitivity rules, split out of sensitivityRules.ts to
// keep each file under the 500-line cap. Both events carry ONLY a spec id, the
// strand reason label, the spec's terminal run ids + statuses, and the bounded
// attempt/attempts counter — all `public` (run ids + a final status are visible run
// lineage, no secrets; no diff content, credentials, or command output).
export const strandSensitivityRules: SensitivityRule[] = [
  // dag.spec.unstranded: the reconciler re-enqueued a confirmed strand.
  ...rulesFor("dag.spec.unstranded", [
    ["specId", "public"],
    ["reason", "public"],
    ["terminalRuns[].runId", "public"],
    ["terminalRuns[].status", "public"],
    ["attempt", "public"],
  ]),
  // dag.spec.needs_attention: a spec parked at the terminal needs_attention status —
  // either a strand exceeded the bounded re-enqueue cap (source `strand`), or the
  // native merge queue judged it genuinely irreconcilable (source `merge_conflict`).
  // All fields are public: run ids + statuses are visible run lineage, the PR url +
  // number are public coordinates, and the message is the resolver's reason (no diff
  // content, credentials, or command output).
  ...rulesFor("dag.spec.needs_attention", [
    ["source", "public"],
    ["specId", "public"],
    ["reason", "public"],
    ["terminalRuns[].runId", "public"],
    ["terminalRuns[].status", "public"],
    ["attempts", "public"],
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["message", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
