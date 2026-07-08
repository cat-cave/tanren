// unit tests for the pure DAG model (`buildProjectDag`), the SVG
// layout (`layoutDag`), and the spec-detail derivation (`buildSpecDetail`).
// These exercise the data-shaping in isolation: status mapping, dependency
// edges, hot/cool flags, attention numbering, critical-path detection,
// group-by columns, and the drawer/full-page detail.

import { describe, expect, it } from "vitest";
import { buildProjectDag } from "../src/api/projectDag.js";
import { layoutDag } from "../src/components/project/dagLayout.js";
import { buildSpecDetail } from "../src/components/project/specDetail.js";
import type { RunListItem, SpecSummary } from "../src/api/types.js";

function run(over: Partial<RunListItem>): RunListItem {
  return {
    runId: "run_x",
    specId: "s1",
    projectId: "p",
    branch: "main",
    trigger: "dashboard",
    status: "running",
    outcome: null,
    startedAt: "2026-05-28T10:00:00.000Z",
    endedAt: null,
    prUrl: null,
    specTitle: "spec",
    costTotalUsd: "1.0",
    lastEventAt: "2026-05-28T10:01:00.000Z",
    needsReview: false,
    ...over,
  };
}

const SPECS = [
  { specId: "s_done", title: "auth schema", dependsOn: [], status: "merged" },
  { specId: "s_live", title: "orders schema", dependsOn: ["s_done"], status: "in_flight" },
  { specId: "s_review", title: "supplier scorecard", dependsOn: ["s_live"], status: "review" },
  { specId: "s_blocked", title: "edi mapping ui", dependsOn: ["s_review"], status: "blocked" },
  { specId: "s_queued", title: "perf budget", dependsOn: [], status: "open" },
];

const MILESTONES = [
  { id: "m1", label: "M1", name: "scaffold", status: "done" },
  { id: "m4", label: "M4", name: "manifold", status: "in_flight" },
];

describe("buildProjectDag", () => {
  const dag = buildProjectDag({
    specs: SPECS,
    milestones: MILESTONES,
    runs: [
      run({ runId: "r_live", specId: "s_live", status: "running" }),
      run({ runId: "r_review", specId: "s_review", status: "completed", needsReview: true }),
      run({ runId: "r_blocked", specId: "s_blocked", status: "completed", outcome: "halted" }),
    ],
  });

  it("maps run state + spec status to the five node statuses", () => {
    const byId = new Map(dag.nodes.map((n) => [n.id, n.status]));
    expect(byId.get("s_done")).toBe("done");
    expect(byId.get("s_live")).toBe("live");
    expect(byId.get("s_review")).toBe("review");
    expect(byId.get("s_blocked")).toBe("blocked");
    expect(byId.get("s_queued")).toBe("queued");
  });

  it("builds dependency edges from dependsOn (dep → dependent)", () => {
    expect(dag.edges).toContainEqual(expect.objectContaining({ from: "s_done", to: "s_live" }));
    expect(dag.edges).toContainEqual(expect.objectContaining({ from: "s_review", to: "s_blocked" }));
    // queued spec has no deps → no edges into it.
    expect(dag.edges.some((e) => e.to === "s_queued")).toBe(false);
  });

  it("flags edges hot when they touch a node that needs action", () => {
    const hot = dag.edges.find((e) => e.from === "s_review" && e.to === "s_blocked");
    expect(hot?.hot).toBe(true);
    const cool = dag.edges.find((e) => e.from === "s_done" && e.to === "s_live");
    // s_live is live (action) so this is hot too; assert the model carries the flag at all.
    expect(typeof cool?.hot).toBe("boolean");
  });

  it("numbers attention badges review→blocked→live and surfaces the strip", () => {
    expect(dag.attention.map((a) => a.kind)).toEqual(["review", "blocked", "live"]);
    expect(dag.attention[0]).toMatchObject({ n: 1, kind: "review", nodeId: "s_review" });
    const reviewNode = dag.nodes.find((n) => n.id === "s_review");
    expect(reviewNode?.attention).toBe(1);
  });

  it("detects critical-path specs (something depends on them)", () => {
    expect(dag.nodes.find((n) => n.id === "s_done")?.onCriticalPath).toBe(true);
    expect(dag.nodes.find((n) => n.id === "s_queued")?.onCriticalPath).toBe(false);
    expect(dag.counts.criticalPath).toBe(3);
  });

  it("counts statuses for the spec-count strip", () => {
    expect(dag.counts).toMatchObject({
      total: 5,
      done: 1,
      live: 1,
      review: 1,
      blocked: 1,
      queued: 1,
    });
  });
});

describe("layoutDag", () => {
  const dag = buildProjectDag({ specs: SPECS, milestones: MILESTONES, runs: [] });

  it("lays out one column per group with placed nodes + edges", () => {
    const layout = layoutDag(dag, "priority");
    expect(layout.nodes.length).toBe(5);
    expect(layout.headers.length).toBeGreaterThan(0);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    // every edge endpoint resolves to a placed node centre.
    for (const edge of layout.edges) {
      expect(Number.isFinite(edge.x1) && Number.isFinite(edge.y2)).toBe(true);
    }
  });

  it("group-by milestone buckets unlinked specs into one column", () => {
    const layout = layoutDag(dag, "milestone");
    // all specs lack milestone links → single 'unlinked' column.
    expect(layout.headers.length).toBe(1);
    expect(layout.headers[0].label).toBe("unlinked");
  });
});

describe("buildSpecDetail", () => {
  const allSpecs: SpecSummary[] = SPECS.map((s) => ({
    specId: s.specId,
    projectId: "p",
    title: s.title,
    description: `desc ${s.title}`,
    acceptanceCriteria: ["renders", "exports"],
    dependsOn: s.dependsOn,
    status: s.status,
  }));
  const statusBySpecId = new Map<string, "done" | "live" | "review" | "blocked" | "queued">([
    ["s_done", "done"],
    ["s_live", "live"],
    ["s_review", "review"],
    ["s_blocked", "blocked"],
    ["s_queued", "queued"],
  ]);

  it("derives status, deps, blocks, latest run, and the blocked reason", () => {
    const blocked = allSpecs.find((s) => s.specId === "s_blocked")!;
    const detail = buildSpecDetail({
      spec: blocked,
      allSpecs,
      runs: [
        run({
          runId: "r_b",
          specId: "s_blocked",
          status: "completed",
          outcome: "halted",
          costTotalUsd: "3.5",
        }),
      ],
      statusBySpecId,
    });
    expect(detail.status).toBe("blocked");
    expect(detail.statusLabel).toBe("blocked");
    expect(detail.dependsOn.map((d) => d.specId)).toEqual(["s_review"]);
    expect(detail.blockedReason).not.toBeNull();
    expect(detail.latestRun?.runId).toBe("r_b");
    expect(detail.spendUsd).toBe("$3.50");
    expect(detail.economics.spendUsd).toBe("$3.50");
    expect(detail.economics.attempts).toBe("1");
    expect(detail.economics.avgCostUsd).toBe("$3.50");
    expect(detail.latestRun?.costLabel).toBe("$3.50");
    expect(detail.runsAvailable).toBe(true);
  });

  it("routes review specs to the review handoff", () => {
    const review = allSpecs.find((s) => s.specId === "s_review")!;
    const detail = buildSpecDetail({
      spec: review,
      allSpecs,
      runs: [run({ runId: "r_r", specId: "s_review", status: "completed", needsReview: true })],
      statusBySpecId,
    });
    expect(detail.status).toBe("review");
    expect(detail.primaryAction?.href).toBe("/runs/r_r/review");
    // s_review blocks s_blocked (reverse edge).
    expect(detail.blocks.map((b) => b.specId)).toEqual(["s_blocked"]);
  });

  it("renders unpriced / zero cost totals as em-dash, never fake $0.00", () => {
    const queued = allSpecs.find((s) => s.specId === "s_queued")!;
    const detail = buildSpecDetail({
      spec: queued,
      allSpecs,
      runs: [
        run({ runId: "r1", specId: "s_queued", status: "completed", outcome: "ok", costTotalUsd: "0" }),
        run({ runId: "r2", specId: "s_queued", status: "completed", outcome: "ok", costTotalUsd: "0.00" }),
      ],
      statusBySpecId,
    });
    expect(detail.spendUsd).toBe("—");
    expect(detail.economics.spendUsd).toBe("—");
    expect(detail.economics.avgCostUsd).toBe("—");
    expect(detail.economics.attempts).toBe("2");
    expect(detail.economics.pricedAttempts).toBe(0);
    expect(detail.runs.every((r) => r.costLabel === "—")).toBe(true);
  });

  it("sums only priced attempts and averages over those", () => {
    const live = allSpecs.find((s) => s.specId === "s_live")!;
    const detail = buildSpecDetail({
      spec: live,
      allSpecs,
      runs: [
        run({ runId: "r_a", specId: "s_live", costTotalUsd: "10.00" }),
        run({ runId: "r_b", specId: "s_live", costTotalUsd: "0" }),
        run({ runId: "r_c", specId: "s_live", costTotalUsd: "5.00" }),
      ],
      statusBySpecId,
    });
    expect(detail.economics.spendUsd).toBe("$15.00");
    expect(detail.economics.avgCostUsd).toBe("$7.50");
    expect(detail.economics.attempts).toBe("3");
    expect(detail.economics.pricedAttempts).toBe(2);
  });

  it("marks runs unavailable when the run-list read failed", () => {
    const review = allSpecs.find((s) => s.specId === "s_review")!;
    const detail = buildSpecDetail({
      spec: review,
      allSpecs,
      runs: [],
      statusBySpecId,
      runsAvailable: false,
    });
    expect(detail.runsAvailable).toBe(false);
    expect(detail.runs).toEqual([]);
    expect(detail.latestRun).toBeNull();
    expect(detail.spendUsd).toBe("—");
    expect(detail.economics.attempts).toBe("—");
    expect(detail.economics.avgCostUsd).toBe("—");
  });

  it("shows em-dash attempts when there are genuinely no runs yet", () => {
    const queued = allSpecs.find((s) => s.specId === "s_queued")!;
    const detail = buildSpecDetail({
      spec: queued,
      allSpecs,
      runs: [],
      statusBySpecId,
      runsAvailable: true,
    });
    expect(detail.runsAvailable).toBe(true);
    expect(detail.economics.attempts).toBe("—");
    expect(detail.economics.spendUsd).toBe("—");
  });
});
