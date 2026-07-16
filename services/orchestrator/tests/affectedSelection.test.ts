import { describe, expect, it } from "vitest";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import { parseDigest } from "../src/engine/contracts/cas.js";
import type { BehaviorCoverageEdgeId } from "../src/engine/contracts/runtimeVerification.js";
import {
  BehaviorCoverageGraphCorruptError,
  buildCoverageAuthorityFingerprint,
  fixedCodeUnitCompare,
  selectAffectedBehaviorRevisions,
  type BehaviorCoverageEdge,
  type BehaviorCoverageSnapshot,
  type BehaviorCoverageSubject,
  type BoundBehaviorCoverageSnapshot,
} from "../src/engine/runtimeVerification/affectedSelection.js";

const BINDING = {
  integrationNodeId: "node-a",
  baseSha: "0".repeat(40),
  preparedHeadSha: "1".repeat(40),
  treeHash: "tree-a",
  memberKey: "2".repeat(64),
};

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

function sealedBound(
  graph: BehaviorCoverageSnapshot,
  changedTargets: readonly { readonly kind: "source"; readonly targetRef: string }[],
): BoundBehaviorCoverageSnapshot {
  return {
    binding: BINDING,
    snapshot: graph,
    authorityFingerprint: buildCoverageAuthorityFingerprint({
      binding: BINDING,
      snapshot: graph,
      changedTargets,
    }),
  };
}

describe("RV4-AFFECTED-SELECTION-FAIL-CLOSED", () => {
  it("selects direct plus transitive behaviors and proves every exclusion", () => {
    const targets = [
      { kind: "source" as const, targetRef: "src/a.ts" },
      { kind: "source" as const, targetRef: "src/a.ts" },
    ];
    const result = selectAffectedBehaviorRevisions({
      bound: sealedBound(COMPLETE_GRAPH, targets),
      changedTargets: targets,
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
    const targets = [{ kind: "source" as const, targetRef: "src/a-mutated.ts" }];
    const result = selectAffectedBehaviorRevisions({
      bound: sealedBound(COMPLETE_GRAPH, targets),
      changedTargets: targets,
    });
    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b", "br-c"]);
    expect(result.excluded).toEqual([]);
  });

  it("mutation negative: deleted edge invalidates the sealed graph and expands every behavior", () => {
    const targets = [{ kind: "source" as const, targetRef: "src/b.ts" }];
    const original = snapshot([
      behavior("br-a", [edge("edge-a", "source", "src/a.ts")]),
      behavior("br-b", [edge("edge-b", "source", "src/b.ts")]),
      behavior("br-c", [edge("edge-c", "source", "src/c.ts")]),
    ]);
    const sealed = sealedBound(original, targets);
    const result = selectAffectedBehaviorRevisions({
      bound: {
        ...sealed,
        snapshot: snapshot([
          behavior("br-a", []),
          behavior("br-b", [edge("edge-b", "source", "src/b.ts")]),
          behavior("br-c", [edge("edge-c", "source", "src/c.ts")]),
        ]),
      },
      changedTargets: targets,
    });
    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b", "br-c"]);
    expect(result.selected.every((item) => item.reasons[0]?.kind === "uncovered_behavior")).toBe(true);
    expect(result.excluded).toEqual([]);
  });

  it("mutation negative: removing a relevant edge while an irrelevant edge remains expands all", () => {
    const targets = [{ kind: "source" as const, targetRef: "src/a.ts" }];
    const original = snapshot([
      behavior("br-a", [edge("edge-relevant", "source", "src/a.ts"), edge("edge-other", "component", "ui")]),
      behavior("br-b", [edge("edge-b", "source", "src/b.ts")]),
    ]);
    const sealed = sealedBound(original, targets);
    const result = selectAffectedBehaviorRevisions({
      bound: {
        ...sealed,
        snapshot: snapshot([
          behavior("br-a", [edge("edge-other", "component", "ui")]),
          behavior("br-b", [edge("edge-b", "source", "src/b.ts")]),
        ]),
      },
      changedTargets: targets,
    });
    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b"]);
    expect(result.excluded).toEqual([]);
  });

  it("mutation negative: omitting one authoritative changed target cannot exclude a behavior", () => {
    const authoritativeTargets = [
      { kind: "source" as const, targetRef: "src/a.ts" },
      { kind: "source" as const, targetRef: "src/c.ts" },
    ];
    const result = selectAffectedBehaviorRevisions({
      bound: sealedBound(COMPLETE_GRAPH, authoritativeTargets),
      changedTargets: authoritativeTargets.slice(0, 1),
    });
    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b", "br-c"]);
    expect(result.excluded).toEqual([]);
  });

  it("missing or malformed authority seals expand the full active set", () => {
    const targets = [{ kind: "source" as const, targetRef: "src/a.ts" }];
    const sealed = sealedBound(COMPLETE_GRAPH, targets);
    const replacement = sealed.authorityFingerprint.endsWith("0") ? "1" : "0";
    for (const authorityFingerprint of ["", `${sealed.authorityFingerprint.slice(0, -1)}${replacement}`]) {
      const result = selectAffectedBehaviorRevisions({
        bound: { ...sealed, authorityFingerprint },
        changedTargets: targets,
      });
      expect(result.mode).toBe("expanded_unknown");
      expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b", "br-c"]);
      expect(result.excluded).toEqual([]);
    }
  });

  it("mutation negative: dangling dependency selects its dependent", () => {
    const targets = [{ kind: "source" as const, targetRef: "src/b.ts" }];
    const graph = snapshot([
      behavior("br-a", [edge("edge-a", "dependency", "missing-revision")]),
      behavior("br-b", [edge("edge-b", "source", "src/b.ts")]),
      behavior("br-c", [edge("edge-c", "source", "src/c.ts")]),
    ]);
    const result = selectAffectedBehaviorRevisions({
      bound: sealedBound(graph, targets),
      changedTargets: targets,
    });
    expect(result.selected[0]).toMatchObject({ behaviorRevisionId: "br-a" });
    expect(result.selected[0]?.reasons).toContainEqual({
      kind: "dangling_dependency",
      edgeId: "edge-a",
      targetRef: "missing-revision",
    });
    expect(result.selected).toHaveLength(3);
    expect(result.excluded).toEqual([]);
  });

  it("empty changed-target input selects the full active set", () => {
    const result = selectAffectedBehaviorRevisions({ bound: sealedBound(COMPLETE_GRAPH, []), changedTargets: [] });
    expect(result.mode).toBe("expanded_unknown");
    expect(result.selected.map((item) => item.behaviorRevisionId)).toEqual(["br-a", "br-b", "br-c"]);
    expect(result.selected.every((item) => item.reasons[0]?.kind === "no_changed_targets")).toBe(true);
  });

  it("zero active behaviors is explicit and never a passing proof", () => {
    const graph = snapshot([]);
    const targets = [{ kind: "source" as const, targetRef: "src/a.ts" }];
    const result = selectAffectedBehaviorRevisions({
      bound: sealedBound(graph, targets),
      changedTargets: targets,
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
        bound: {
          binding: BINDING,
          snapshot: snapshot([
            behavior("br-a", [edge("duplicate", "source", "src/a.ts")]),
            behavior("br-b", [edge("duplicate", "source", "src/b.ts")]),
          ]),
          authorityFingerprint: "",
        },
        changedTargets: [{ kind: "source", targetRef: "src/a.ts" }],
      }),
    ).toThrow(BehaviorCoverageGraphCorruptError);
    expect(() =>
      selectAffectedBehaviorRevisions({
        bound: {
          binding: BINDING,
          snapshot: snapshot([behavior("br-a", []), behavior("br-a", [])]),
          authorityFingerprint: "",
        },
        changedTargets: [],
      }),
    ).toThrow(BehaviorCoverageGraphCorruptError);
  });

  it("uses fixed code-unit ordering for Unicode CAS inputs regardless of locale collation", () => {
    const values = ["ä", "z", "😀", "a", "Ω"];
    const en = new Intl.Collator("en");
    const sv = new Intl.Collator("sv");
    expect([...values].sort((left, right) => en.compare(left, right))).not.toEqual(
      [...values].sort((left, right) => sv.compare(left, right)),
    );
    expect([...values].sort(fixedCodeUnitCompare)).toEqual(["a", "z", "ä", "Ω", "😀"]);

    const targets = values.map((targetRef) => ({ kind: "source" as const, targetRef }));
    const graph = snapshot(values.map((id, index) => behavior(id, [edge(`edge-${index}`, "source", id)])));
    const forward = selectAffectedBehaviorRevisions({ bound: sealedBound(graph, targets), changedTargets: targets });
    const reverse = selectAffectedBehaviorRevisions({
      bound: sealedBound({ ...graph, behaviors: graph.behaviors.toReversed() }, targets.toReversed()),
      changedTargets: targets.toReversed(),
    });
    expect(reverse).toEqual(forward);
  });
});
