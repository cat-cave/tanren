import { describe, expect, it } from "vitest";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import type { BehaviorCoverageEdgeId } from "../src/engine/contracts/runtimeVerification.js";
import {
  BehaviorCoverageGraphCorruptError,
  selectAffectedBehaviorRevisions,
  type BehaviorCoverageEdge,
  type BehaviorCoverageSnapshot,
  type BehaviorCoverageSubject,
} from "../src/engine/runtimeVerification/affectedSelection.js";

function revision(id: string): BehaviorRevisionId {
  return id as BehaviorRevisionId;
}

function edge(id: string, kind: BehaviorCoverageEdge["kind"], targetRef: string): BehaviorCoverageEdge {
  return { id: id as BehaviorCoverageEdgeId, kind, targetRef };
}

function behavior(id: string, edges: readonly BehaviorCoverageEdge[]): BehaviorCoverageSubject {
  return { behaviorRevisionId: revision(id), title: id, edges };
}

function snapshot(behaviors: readonly BehaviorCoverageSubject[]): BehaviorCoverageSnapshot {
  return { orgId: "org-a", projectId: "project-a", behaviors };
}

const COMPLETE_GRAPH = snapshot([
  behavior("br-a", [edge("edge-a", "source", "src/a.ts")]),
  behavior("br-b", [edge("edge-b", "dependency", "br-a")]),
  behavior("br-c", [edge("edge-c", "source", "src/c.ts")]),
]);

describe("AffectedSelectionV1", () => {
  it("RV4-AFFECTED-SELECTION-FAIL-CLOSED selects direct + transitive behaviors and proves every exclusion", () => {
    const result = selectAffectedBehaviorRevisions({
      analysisId: "analysis-1",
      snapshot: COMPLETE_GRAPH,
      changedTargets: [
        { kind: "source", targetRef: "src/a.ts" },
        { kind: "source", targetRef: "src/a.ts" },
      ],
    });

    expect(result).toMatchObject({
      version: "v1",
      mode: "targeted",
      changedTargets: [{ kind: "source", targetRef: "src/a.ts" }],
      unknownTargets: [],
    });
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b"]);
    expect(result.selected[0]?.reasons).toEqual([
      { kind: "direct_edge", edgeId: "edge-a", target: { kind: "source", targetRef: "src/a.ts" } },
    ]);
    expect(result.selected[1]?.reasons).toEqual([
      { kind: "transitive_dependency", edgeId: "edge-b", dependencyBehaviorRevisionId: "br-a" },
    ]);
    expect(result.excluded).toEqual([
      {
        behaviorRevisionId: "br-c",
        reason: "no_reachable_changed_target",
        inspectedEdgeIds: ["edge-c"],
      },
    ]);
  });

  it("mutation negative: a changed target-ref no longer covered expands to the full active set", () => {
    const result = selectAffectedBehaviorRevisions({
      analysisId: "analysis-mutated-target",
      snapshot: COMPLETE_GRAPH,
      changedTargets: [{ kind: "source", targetRef: "src/a-mutated.ts" }],
    });

    expect(result.mode).toBe("expanded_unknown");
    expect(result.unknownTargets).toEqual([{ kind: "source", targetRef: "src/a-mutated.ts" }]);
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b", "br-c"]);
    expect(result.excluded).toEqual([]);
    for (const selected of result.selected) {
      expect(selected.reasons).toContainEqual({
        kind: "unknown_target",
        target: { kind: "source", targetRef: "src/a-mutated.ts" },
      });
    }
  });

  it("mutation negative: deleting an edge selects the uncovered behavior instead of silently omitting it", () => {
    const result = selectAffectedBehaviorRevisions({
      analysisId: "analysis-deleted-edge",
      snapshot: snapshot([
        behavior("br-a", []),
        behavior("br-b", [edge("edge-b", "source", "src/b.ts")]),
        behavior("br-c", [edge("edge-c", "source", "src/c.ts")]),
      ]),
      changedTargets: [{ kind: "source", targetRef: "src/b.ts" }],
    });

    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected).toEqual([
      { behaviorRevisionId: "br-a", reasons: [{ kind: "uncovered_behavior" }] },
      {
        behaviorRevisionId: "br-b",
        reasons: [{ kind: "direct_edge", edgeId: "edge-b", target: { kind: "source", targetRef: "src/b.ts" } }],
      },
    ]);
    expect(result.excluded[0]?.behaviorRevisionId).toBe("br-c");
    expect(result.excluded[0]?.inspectedEdgeIds).toEqual(["edge-c"]);
  });

  it("mutation negative: a dangling dependency selects its dependent as unknown", () => {
    const result = selectAffectedBehaviorRevisions({
      analysisId: "analysis-dangling-dependency",
      snapshot: snapshot([
        behavior("br-a", [edge("edge-a", "dependency", "missing-revision")]),
        behavior("br-b", [edge("edge-b", "source", "src/b.ts")]),
        behavior("br-c", [edge("edge-c", "source", "src/c.ts")]),
      ]),
      changedTargets: [{ kind: "source", targetRef: "src/b.ts" }],
    });

    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected).toContainEqual({
      behaviorRevisionId: "br-a",
      reasons: [{ kind: "dangling_dependency", edgeId: "edge-a", targetRef: "missing-revision" }],
    });
    expect(result.selected.map((item) => item.behaviorRevisionId)).toContain("br-b");
    expect(result.excluded[0]?.behaviorRevisionId).toBe("br-c");
  });

  it("selects the full active set when no targets were supplied", () => {
    const result = selectAffectedBehaviorRevisions({
      analysisId: "analysis-no-targets",
      snapshot: COMPLETE_GRAPH,
      changedTargets: [],
    });

    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b", "br-c"]);
    expect(result.selected.every((item) => item.reasons[0]?.kind === "no_changed_targets")).toBe(true);
    expect(result.excluded).toEqual([]);
  });

  it("reports zero active behaviors as a non-green state", () => {
    const result = selectAffectedBehaviorRevisions({
      analysisId: "analysis-empty",
      snapshot: snapshot([]),
      changedTargets: [{ kind: "source", targetRef: "src/a.ts" }],
    });

    expect(result).toMatchObject({
      mode: "no_active_behaviors",
      selected: [],
      excluded: [],
      unknownTargets: [{ kind: "source", targetRef: "src/a.ts" }],
    });
  });

  it("rejects a graph snapshot that reuses one edge id across behavior revisions", () => {
    expect(() =>
      selectAffectedBehaviorRevisions({
        analysisId: "analysis-corrupt",
        snapshot: snapshot([
          behavior("br-a", [edge("duplicate", "source", "src/a.ts")]),
          behavior("br-b", [edge("duplicate", "source", "src/b.ts")]),
        ]),
        changedTargets: [{ kind: "source", targetRef: "src/a.ts" }],
      }),
    ).toThrow(BehaviorCoverageGraphCorruptError);
  });
});
