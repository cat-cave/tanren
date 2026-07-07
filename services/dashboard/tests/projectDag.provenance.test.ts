// Codex H3 #9 — the DASHBOARD side of the triage-routing PROVENANCE
// round-trip. The orchestrator's spec-list response now carries
// `triageProvenance` per row (Codex H3 #8); `buildProjectDag` threads the
// trail from each SpecSummary onto the corresponding DagNode so the DAG view
// can render the routing chain for a routed spec node. This pins that the
// trail survives the model build unchanged (routed rows expose the block;
// non-routed rows omit it) — a regression that dropped the trail here would
// silently hide the routing origin in the view even with the server exposing it.

import { describe, expect, it } from "vitest";
import { buildProjectDag } from "../src/api/projectDag.js";

describe("buildProjectDag — triage PROVENANCE threading (Codex H3 #9)", () => {
  it("threads triageProvenance from a routed SpecSummary onto its DagNode", () => {
    const dag = buildProjectDag({
      specs: [
        {
          specId: "spec_seed",
          title: "seed",
          dependsOn: [],
          status: "merged",
        },
        {
          specId: "spec_routed",
          title: "routed",
          dependsOn: [],
          status: "open",
          triageProvenance: {
            parentSpecId: "spec_parent",
            sourceFindingIds: ["finding_1"],
            originTriageTaskId: "task_triage_a",
            originRunId: "run_source_a",
          },
        },
      ],
      milestones: [],
      runs: [],
    });
    const byId = new Map(dag.nodes.map((n) => [n.id, n]));
    expect(byId.get("spec_seed")?.triageProvenance).toBeUndefined();
    expect(byId.get("spec_routed")?.triageProvenance).toEqual({
      parentSpecId: "spec_parent",
      sourceFindingIds: ["finding_1"],
      originTriageTaskId: "task_triage_a",
      originRunId: "run_source_a",
    });
  });
});
