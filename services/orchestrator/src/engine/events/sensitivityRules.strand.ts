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
    // strand source: the fine-grained cause + WHOSE bug the halt is. Closed
    // vocabularies from the classifier (worker/runFailureCause), selected by the error
    // CLASS name and never message-derived — the legibility fix that lets an operator
    // see which repository to open without a join.
    ["cause", "public"],
    ["attribution", "public"],
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["message", "public"],
    // cancelled_ancestor source: the operator-cancelled ancestor the dependent assumed
    // (a spec id — run lineage, no secret).
    ["cancelledAncestorSpecId", "public"],
  ]),
  // spec.cancelled / run.cancelled: the operator cancel-spec/cancel-run action. All
  // fields are public — spec/run ids are run lineage, `fromStatus` is an enum label,
  // `cancelledBy` is the operator's user id (an actor handle), and the dependent ids /
  // runner id carry no secret (no diff content, credentials, or command output).
  ...rulesFor("spec.cancelled", [
    ["specId", "public"],
    ["fromStatus", "public"],
    ["cancelledBy", "public"],
    ["dependentsParked[]", "public"],
  ]),
  ...rulesFor("run.cancelled", [
    ["runId", "public"],
    ["fromStatus", "public"],
    ["cancelledBy", "public"],
    ["runnerId", "public"],
    ["runnerReleased", "public"],
  ]),
  // dag.spec.redriven (apex v35): a random/transient run failure RE-DRIVES the spec
  // (→ open) instead of stranding it — the never-strand sibling. All fields public-safe:
  // spec/run ids (run lineage), the CLASSIFIED failure code + stage (closed vocabulary,
  // never the raw error string), and the consecutive-failure / cap / backoff counters
  // (no diff content, credentials, or command output).
  ...rulesFor("dag.spec.redriven", [
    ["specId", "public"],
    ["runId", "public"],
    ["failureCode", "public"],
    ["stage", "public"],
    ["consecutiveSameFailure", "public"],
    ["workSignature", "public"],
    ["backoffSeconds", "public"],
    // The fine-grained cause + attribution + the named blocking precondition. All three
    // are closed vocabularies from the classifier, never derived from an error message.
    ["cause", "public"],
    ["attribution", "public"],
    ["precondition", "public"],
    // Audit finding #13: discriminator that excludes prober resumes — and now
    // precondition blocks — from the structural-redrive convergence history. Closed
    // vocabulary, no secrets.
    ["source", "public"],
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
