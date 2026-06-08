import type { SensitivityRule } from "./sensitivity.js";

// The spec-parked-state sensitivity rules (needs_attention + attention_resolved),
// split out of sensitivityRules.ts to keep each file under the 500-line cap. Each
// event carries ONLY a spec id, an enum label, the spec's terminal run ids +
// statuses, the bounded attempts counter, and the resolver/operator handle — all
// `public` (run ids + a final status are visible run lineage, no secrets; no diff
// content, credentials, or command output).
export const strandSensitivityRules: SensitivityRule[] = [
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
  // dag.spec.attention_resolved: an operator resolved a needs_attention escalation
  // and re-queued the spec. All fields are public — the spec id is run lineage, the
  // `fromSource` is an enum label, and `resolvedBy` is a user id (an actor handle, no
  // secret, no diff content, no command output).
  ...rulesFor("dag.spec.attention_resolved", [
    ["specId", "public"],
    ["fromSource", "public"],
    ["resolvedBy", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
