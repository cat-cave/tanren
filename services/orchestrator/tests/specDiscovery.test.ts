// P3-0014 spec-discovery engine tests.
//
// Exercises classification (with a MOCKED discovery answerer — no provider is
// contacted), the deterministic fallback answerer for each variant, and the
// accept path (spec created via the existing createSpec path + provenance
// stamped onto the spec's metadata). The pool is a lightweight in-memory stub
// keyed by SQL substring, mirroring the orchestrator engine-test pattern.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  acceptProposals,
  classifyInsight,
  createDeterministicDiscoveryAnswerer,
  parseDiscoveryProvenance,
  type DiscoveryAnswerer,
  type DiscoveryInsight,
  type DiscoveryResult
} from "../src/engine/forge/discovery/index.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: "project_a",
  scopes: ["platform:admin"],
  source: "session"
};

const featureInsight: DiscoveryInsight = {
  variant: "feature",
  source: "hubspot · acme co",
  sourceLabel: "sales call note",
  who: "dani · ae",
  when: "2h ago",
  glyph: "⌥",
  body: "acme wants to export the stats page to csv for their monthly board pack."
};

// In-memory pool: tracks inserted specs + their metadata so the accept path's
// createSpec + writeProvenance round-trip is observable.
function stubPool(existingSpecs: Array<{ spec_id: string; title: string; status: string }> = []): {
  pool: pg.Pool;
  specs: Map<string, { metadata: unknown }>;
} {
  const specs = new Map<string, { metadata: unknown }>();
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return { rows: existingSpecs, rowCount: existingSpecs.length };
    }
    if (sql.startsWith("SELECT project_id FROM projects")) {
      return { rows: [{ project_id: params[0] }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO specs")) {
      const specId = String(params[0]);
      specs.set(specId, { metadata: {} });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT metadata FROM specs")) {
      const specId = String(params[0]);
      const row = specs.get(specId);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE specs SET metadata")) {
      const specId = String(params[0]);
      const metadata = JSON.parse(String(params[1])) as unknown;
      specs.set(specId, { metadata });
      return { rows: [{ spec_id: specId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query } as unknown as pg.Pool, specs };
}

describe("classifyInsight (mocked answerer)", () => {
  it("returns the answerer's classification and grounds it with existing specs", async () => {
    const { pool } = stubPool([{ spec_id: "s_done", title: "stats page", status: "done" }]);
    let seenExisting = 0;
    const answerer: DiscoveryAnswerer = {
      async classify(ctx) {
        seenExisting = ctx.existingSpecs.length;
        return {
          variant: "feature",
          summary: "one spec covers it",
          proposals: [
            {
              proposalId: "p1",
              title: "csv export",
              description: "add csv export",
              acceptanceCriteria: ["exports csv"],
              dependsOn: [],
              priority: "P1",
              estLabel: "2h"
            }
          ],
          placements: [
            { kind: "jump_backlog", label: "jump", eta: "3d", sideEffects: "none", priority: "P1", recommended: true, risk: false }
          ],
          deltas: [],
          readSummary: ""
        } satisfies DiscoveryResult;
      }
    };

    const result = await classifyInsight({ pool, answerer }, { projectId: "project_a", insight: featureInsight, actor });
    expect(seenExisting).toBe(1);
    expect(result.proposals[0]?.title).toBe("csv export");
    expect(result.placements.some((p) => p.recommended)).toBe(true);
  });
});

describe("deterministic discovery answerer · per variant", () => {
  for (const [variant, minProposals] of [["feature", 1], ["bug", 3], ["strategic", 4]] as const) {
    it(`${variant}: proposes ${minProposals}+ spec(s) + three placement options with one recommended`, async () => {
      const { pool } = stubPool([{ spec_id: "s_done", title: "stats page", status: "done" }]);
      const insight: DiscoveryInsight = { ...featureInsight, variant };
      const result = await classifyInsight({ pool }, { projectId: "project_a", insight, actor });
      expect(result.variant).toBe(variant);
      expect(result.proposals.length).toBeGreaterThanOrEqual(minProposals);
      // Three canonical placements, exactly one recommended.
      expect(result.placements.map((p) => p.kind).sort()).toEqual(["interrupt", "jump_backlog", "slot_after"]);
      expect(result.placements.filter((p) => p.recommended)).toHaveLength(1);
      // Impact deltas cover personas/behaviors/specs.
      expect(result.deltas.map((d) => d.title)).toContain("specs");
    });
  }

  it("feature: grounds the lead proposal's dependsOn against a shipped spec", async () => {
    const { pool } = stubPool([{ spec_id: "s_done", title: "stats page", status: "merged" }]);
    const result = await classifyInsight({ pool }, { projectId: "project_a", insight: featureInsight, actor });
    expect(result.proposals[0]?.dependsOn).toContain("s_done");
  });

  it("bug: recommends the interrupt placement", async () => {
    const answerer = createDeterministicDiscoveryAnswerer();
    const result = await answerer.classify({
      insight: { ...featureInsight, variant: "bug" },
      projectId: "project_a",
      existingSpecs: []
    });
    const recommended = result.placements.find((p) => p.recommended);
    expect(recommended?.kind).toBe("interrupt");
  });
});

describe("acceptProposals · creates specs + stamps provenance", () => {
  it("creates each accepted spec and persists discovery provenance on its metadata", async () => {
    const { pool, specs } = stubPool();
    const result = await acceptProposals(
      { pool },
      {
        projectId: "project_a",
        insight: featureInsight,
        proposals: [
          {
            proposalId: "p1",
            title: "add csv export to the stats page",
            description: "csv export",
            acceptanceCriteria: ["exports csv"],
            dependsOn: [],
            priority: "P1",
            estLabel: "2h · $0.45"
          }
        ],
        placementKind: "jump_backlog",
        placementLabel: "jump the p1 backlog",
        actor
      }
    );

    expect(result.accepted).toHaveLength(1);
    const created = result.accepted[0];
    expect(created?.spec.specId).toMatch(/^spec_/);
    expect(created?.proposalId).toBe("p1");

    // Provenance landed on the spec's metadata under the discovery key.
    const stored = specs.get(created!.spec.specId);
    const provenance = parseDiscoveryProvenance(stored?.metadata);
    expect(provenance?.variant).toBe("feature");
    expect(provenance?.insightSource).toBe("hubspot · acme co");
    expect(provenance?.placementKind).toBe("jump_backlog");
    expect(provenance?.insightExcerpt).toContain("csv");
  });

  it("commits all three proposals for a bug triage accept", async () => {
    const { pool, specs } = stubPool();
    const answerer = createDeterministicDiscoveryAnswerer();
    const classification = await answerer.classify({
      insight: { ...featureInsight, variant: "bug" },
      projectId: "project_a",
      existingSpecs: []
    });
    const result = await acceptProposals(
      { pool },
      {
        projectId: "project_a",
        insight: { ...featureInsight, variant: "bug" },
        proposals: classification.proposals,
        placementKind: "interrupt",
        placementLabel: "interrupt now",
        actor
      }
    );
    expect(result.accepted).toHaveLength(3);
    expect(specs.size).toBe(3);
    for (const [, row] of specs) {
      expect(parseDiscoveryProvenance(row.metadata)?.placementKind).toBe("interrupt");
    }
  });
});
