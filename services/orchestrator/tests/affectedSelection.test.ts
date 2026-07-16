import { describe, expect, it } from "vitest";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import { parseDigest } from "../src/engine/contracts/cas.js";
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

function behavior(id: string, edges: readonly BehaviorCoverageEdge[], digestChar = "a"): BehaviorCoverageSubject {
  return {
    behaviorRevisionId: revision(id),
    contentDigest: parseDigest(`sha256:${digestChar.repeat(64)}`),
    title: id,
    edges,
  };
}

function snapshot(behaviors: readonly BehaviorCoverageSubject[]): BehaviorCoverageSnapshot {
  return { orgId: "org-a", projectId: "project-a", behaviors };
}

const COMPLETE_GRAPH = snapshot([
  behavior("br-a", [edge("edge-a", "source", "src/a.ts")], "a"),
  behavior("br-b", [edge("edge-b", "dependency", "br-a")], "b"),
  behavior("br-c", [edge("edge-c", "source", "src/c.ts")], "c"),
]);

describe("RV4-AFFECTED-SELECTION-FAIL-CLOSED", () => {
  it("selects direct plus transitive behaviors and proves every exclusion", () => {
    const result = selectAffectedBehaviorRevisions({
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

  it("mutation negative: unknown target expands to every active revision", () => {
    const result = selectAffectedBehaviorRevisions({
      snapshot: COMPLETE_GRAPH,
      changedTargets: [{ kind: "source", targetRef: "src/a-mutated.ts" }],
    });
    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b", "br-c"]);
    expect(result.excluded).toEqual([]);
  });

  it("mutation negative: deleted edge selects the uncovered behavior", () => {
    const result = selectAffectedBehaviorRevisions({
      snapshot: snapshot([
        behavior("br-a", []),
        behavior("br-b", [edge("edge-b", "source", "src/b.ts")]),
        behavior("br-c", [edge("edge-c", "source", "src/c.ts")]),
      ]),
      changedTargets: [{ kind: "source", targetRef: "src/b.ts" }],
    });
    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected).toContainEqual({
      behaviorRevisionId: "br-a",
      reasons: [{ kind: "uncovered_behavior" }],
    });
    expect(result.excluded[0]?.behaviorRevisionId).toBe("br-c");
  });

  it("mutation negative: dangling dependency selects its dependent", () => {
    const result = selectAffectedBehaviorRevisions({
      snapshot: snapshot([
        behavior("br-a", [edge("edge-a", "dependency", "missing-revision")]),
        behavior("br-b", [edge("edge-b", "source", "src/b.ts")]),
        behavior("br-c", [edge("edge-c", "source", "src/c.ts")]),
      ]),
      changedTargets: [{ kind: "source", targetRef: "src/b.ts" }],
    });
    expect(result.selected).toContainEqual({
      behaviorRevisionId: "br-a",
      reasons: [{ kind: "dangling_dependency", edgeId: "edge-a", targetRef: "missing-revision" }],
    });
  });

  it("empty changed-target input selects the full active set", () => {
    const result = selectAffectedBehaviorRevisions({ snapshot: COMPLETE_GRAPH, changedTargets: [] });
    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b", "br-c"]);
    expect(result.selected.every((item) => item.reasons[0]?.kind === "no_changed_targets")).toBe(true);
  });

  it("zero active behaviors is explicit and never a passing proof", () => {
    const result = selectAffectedBehaviorRevisions({
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

  it("rejects duplicate behavior and edge identities instead of canonicalizing corruption", () => {
    expect(() =>
      selectAffectedBehaviorRevisions({
        snapshot: snapshot([
          behavior("br-a", [edge("duplicate", "source", "src/a.ts")]),
          behavior("br-b", [edge("duplicate", "source", "src/b.ts")]),
        ]),
        changedTargets: [{ kind: "source", targetRef: "src/a.ts" }],
      }),
    ).toThrow(BehaviorCoverageGraphCorruptError);
    expect(() =>
      selectAffectedBehaviorRevisions({
        snapshot: snapshot([behavior("br-a", []), behavior("br-a", [])]),
        changedTargets: [],
      }),
    ).toThrow(BehaviorCoverageGraphCorruptError);
  });
});
