// Seam conformance suite for the ConflictProvenanceReader contract
// (engine/contracts/conflictResolution.ts). The reusable behavior spec every
// provenance impl must satisfy (autonomy-engine.md §2b step 1): identify the
// OTHER conflicting spec from the DAG + the conflicting files' recent merge
// provenance, and report whether a DAG edge connects the two. It pins the
// CONTRACT behaviorally through the public `read(...)` surface only:
//
//   - prefer a DAG-ADJACENT merged spec (dagEdge=true);
//   - fall back to the most-recently-merged PROJECT spec when no adjacent spec
//     has merged (dagEdge=false — a real provenance signal without a known
//     dependency relationship);
//   - never attribute the merging spec to itself;
//   - attribute NOTHING (undefined, dagEdge=false) when no other spec has merged,
//     so the resolver proceeds with the merging spec's intent alone rather than
//     dropping the merge.
//
// The harness supplies a DAG the test seeds (merged specs + edges) so the SAME spec
// runs against any ConflictProvenanceReader impl. Mirrors the Allocator /
// JobQueue / DagWalker / Repositories suites.

import { describe, expect, it } from "vitest";
import type { ConflictProvenanceReader, SpecIntent } from "../../src/engine/contracts/conflictResolution.js";

export interface ProvenanceSpecSeed {
  intent: SpecIntent;
  /** When set, the spec's run has MERGED at this ordering rank (higher = later). */
  mergedRank?: number;
}

export interface ConflictProvenanceConformanceHarness {
  reader: ConflictProvenanceReader;
  readonly projectId: string;
  /** Seed a spec into the project (optionally marking its run merged). */
  setSpec(seed: ProvenanceSpecSeed): void;
  /** Add a DAG dependency edge from→to (either direction is adjacency). */
  addEdge(fromSpecId: string, toSpecId: string): void;
}

export interface ConflictProvenanceConformanceSuite {
  make(): ConflictProvenanceConformanceHarness;
}

function intent(specId: string): SpecIntent {
  return {
    specId,
    title: `Title ${specId}`,
    description: `Description ${specId}`,
    acceptanceCriteria: [`criterion of ${specId}`],
  };
}

function read(h: ConflictProvenanceConformanceHarness, mergingSpecId: string) {
  return h.reader.read({ projectId: h.projectId, mergingSpecId, conflictedFiles: ["src/router.ts"] });
}

export function describeConflictProvenanceConformance(label: string, suite: ConflictProvenanceConformanceSuite): void {
  describe(`ConflictProvenanceReader conformance: ${label}`, () => {
    it("attributes a DAG-adjacent merged spec and reports the edge", async () => {
      const h = suite.make();
      h.setSpec({ intent: intent("spec_merging") });
      h.setSpec({ intent: intent("spec_dep"), mergedRank: 1 });
      h.addEdge("spec_merging", "spec_dep");

      const result = await read(h, "spec_merging");
      expect(result.conflictingSpecId).toBe("spec_dep");
      expect(result.dagEdge).toBe(true);
      expect(result.conflictingSpecIntent?.specId).toBe("spec_dep");
      expect(result.conflictingSpecIntent?.acceptanceCriteria).toEqual(["criterion of spec_dep"]);
    });

    it("reports the edge for a dependent (incoming) merged spec too", async () => {
      const h = suite.make();
      h.setSpec({ intent: intent("spec_merging") });
      h.setSpec({ intent: intent("spec_dependent"), mergedRank: 1 });
      // spec_dependent depends ON spec_merging (incoming edge) — still adjacency.
      h.addEdge("spec_dependent", "spec_merging");

      const result = await read(h, "spec_merging");
      expect(result.conflictingSpecId).toBe("spec_dependent");
      expect(result.dagEdge).toBe(true);
    });

    it("prefers a DAG-adjacent merged spec over a more-recently-merged unrelated one", async () => {
      const h = suite.make();
      h.setSpec({ intent: intent("spec_merging") });
      h.setSpec({ intent: intent("spec_adjacent"), mergedRank: 1 });
      // spec_unrelated merged later (higher rank) but is NOT adjacent.
      h.setSpec({ intent: intent("spec_unrelated"), mergedRank: 5 });
      h.addEdge("spec_merging", "spec_adjacent");

      const result = await read(h, "spec_merging");
      expect(result.conflictingSpecId).toBe("spec_adjacent");
      expect(result.dagEdge).toBe(true);
    });

    it("falls back to the most-recently-merged project spec when none is adjacent (dagEdge=false)", async () => {
      const h = suite.make();
      h.setSpec({ intent: intent("spec_merging") });
      h.setSpec({ intent: intent("spec_old"), mergedRank: 1 });
      h.setSpec({ intent: intent("spec_recent"), mergedRank: 9 });

      const result = await read(h, "spec_merging");
      expect(result.conflictingSpecId).toBe("spec_recent");
      expect(result.dagEdge).toBe(false);
    });

    it("never attributes the merging spec to itself", async () => {
      const h = suite.make();
      // Only the merging spec has merged — there is no OTHER spec.
      h.setSpec({ intent: intent("spec_merging"), mergedRank: 3 });

      const result = await read(h, "spec_merging");
      expect(result.conflictingSpecId).toBeUndefined();
      expect(result.dagEdge).toBe(false);
    });

    it("attributes nothing when no other spec has merged (resolver proceeds alone)", async () => {
      const h = suite.make();
      h.setSpec({ intent: intent("spec_merging") });
      // spec_pending never merged (no mergedRank), so it is not attributable.
      h.setSpec({ intent: intent("spec_pending") });
      h.addEdge("spec_merging", "spec_pending");

      const result = await read(h, "spec_merging");
      expect(result.conflictingSpecId).toBeUndefined();
      expect(result.dagEdge).toBe(false);
    });
  });
}
