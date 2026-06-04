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
  // dag.spec.needs_attention: a strand exceeded the bounded re-enqueue cap and was
  // escalated to the terminal needs_attention status.
  ...rulesFor("dag.spec.needs_attention", [
    ["specId", "public"],
    ["reason", "public"],
    ["terminalRuns[].runId", "public"],
    ["terminalRuns[].status", "public"],
    ["attempts", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
