import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  MergeQueueRepairRoutesClient,
  type MergeQueueRepairRoute,
  type MergeQueueRepairRoutesListResponse,
  type RepairRouteDisposition,
} from "../src/api/mergeQueueRepairRoutes.js";
import { RepairRouteLineagePanel } from "../src/components/mergeQueue/RepairRouteLineagePanel.js";

function route(
  disposition: RepairRouteDisposition,
  overrides: Partial<MergeQueueRepairRoute> = {},
): MergeQueueRepairRoute {
  return {
    routeId: `route_${disposition}`,
    sourceSpecId: "spec_stuck",
    groupId: "mqgrp_x",
    evaluationId: "mqeval_x",
    disposition,
    failureClass: "deterministic_policy",
    failureSignature: "rc:audit_policy|fi:f1",
    magnitude: 1,
    findingIds: ["f1"],
    reasonCodes: ["audit_policy"],
    respecGeneration: 0,
    priorAgentRoute: null,
    nextAgentRoute: null,
    packetHash: null,
    replacementSpecIds: [],
    observedAt: "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

async function render(projection: MergeQueueRepairRoutesListResponse | undefined): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.html(RepairRouteLineagePanel({ projection })));
  return await (await app.request("/")).text();
}

describe("mq-10 repair-route lineage dashboard surface", () => {
  it("renders an unavailable read as an explicit failure, never green or empty", async () => {
    const unavailable: MergeQueueRepairRoutesListResponse | undefined = undefined;
    const html = await render(unavailable);
    expect(html).toContain("autonomous repair · respec lineage");
    expect(html).toContain("Repair-route lineage unavailable");
    // Neither a repair nor a respec disposition may render on an unavailable read.
    expect(html).not.toContain("repair in place");
    expect(html).not.toContain("routed to a different agent");
  });

  it("renders a read with zero routings as the fail-closed empty state, not a repair row", async () => {
    const html = await render({ repairRoutes: [] });
    expect(html).toContain("No autonomous-repair routings yet");
    // No rendered route row (the CSS block still names .mq10-route/.mq10-list; a row is a div
    // whose class attribute starts with the disposition-bearing class).
    expect(html).not.toContain('class="mq10-route');
    expect(html).not.toContain('class="mq10-list"');
  });

  it("renders an in-place repair row with its spec, failure class, magnitude and signature", async () => {
    const html = await render({ repairRoutes: [route("repair_in_place")] });
    expect(html).toContain("repair in place · writer rework");
    expect(html).toContain("spec</b> spec_stuck");
    expect(html).toContain("failure</b> deterministic_policy");
    expect(html).toContain("magnitude</b> 1");
    expect(html).toContain("rc:audit_policy|fi:f1");
    // The respec-only lineage line must NOT appear for a plain repair.
    expect(html).not.toContain("→");
  });

  it("renders a respec row with its generation, prior→next agent hop, replacement specs and packet hash", async () => {
    const html = await render({
      repairRoutes: [
        route("respec", {
          respecGeneration: 2,
          priorAgentRoute: "writer.in_place",
          nextAgentRoute: "answerer.respec",
          replacementSpecIds: ["spec_a", "spec_b"],
          packetHash: "sha256:deadbeef",
        }),
      ],
    });
    expect(html).toContain("respec · routed to a different agent");
    expect(html).toContain("gen</b> 2");
    expect(html).toContain("writer.in_place");
    expect(html).toContain("answerer.respec");
    expect(html).toContain("→");
    expect(html).toContain("spec_a, spec_b");
    expect(html).toContain("sha256:deadbeef");
    // The state class drives the respec accent styling.
    expect(html).toContain('class="mq10-route respec"');
  });

  it("renders an empty replacement set and absent packet as em-dash sentinels, never a fake value", async () => {
    const html = await render({
      repairRoutes: [
        route("respec", {
          respecGeneration: 1,
          priorAgentRoute: "writer.in_place",
          nextAgentRoute: "answerer.respec",
          replacementSpecIds: [],
          packetHash: null,
        }),
      ],
    });
    expect(html).toContain("replacement</b> —");
    expect(html).toContain("packet</b> —");
  });

  it("renders a blocked route as the fail-closed needs-attention disposition", async () => {
    const html = await render({ repairRoutes: [route("blocked_needs_attention")] });
    expect(html).toContain("blocked · needs attention (fail-closed)");
    expect(html).toContain('class="mq10-route blocked_needs_attention"');
  });

  it("falls back to the raw disposition string for any unrecognized disposition (defensive)", async () => {
    const html = await render({
      repairRoutes: [route("future_unknown_disposition" as RepairRouteDisposition)],
    });
    // The switch default surfaces the raw value rather than dropping the row.
    expect(html).toContain("future_unknown_disposition");
  });

  it("preserves the projection order (newest-first) across a mixed lineage", async () => {
    const html = await render({
      repairRoutes: [
        route("respec", { routeId: "r_new", sourceSpecId: "spec_new" }),
        route("repair_in_place", { routeId: "r_old", sourceSpecId: "spec_old" }),
      ],
    });
    expect(html.indexOf("spec_new")).toBeLessThan(html.indexOf("spec_old"));
  });
});

describe("MergeQueueRepairRoutesClient", () => {
  it("requests the org/project repair-routes projection with an encoded, capped limit", async () => {
    const calls: string[] = [];
    const payload: MergeQueueRepairRoutesListResponse = { repairRoutes: [route("respec")] };
    const client = new MergeQueueRepairRoutesClient({
      orchestratorUrl: "http://orchestrator:3000",
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    });

    const result = await client.listRepairRoutes("org/acme", "project tanren", 7);
    expect(result).toEqual(payload);
    expect(calls).toEqual([
      "http://orchestrator:3000/orgs/org%2Facme/projects/project%20tanren/merge-queue/repair-routes?limit=7",
    ]);
  });

  it("defaults to a 50-row limit when none is supplied", async () => {
    const calls: string[] = [];
    const client = new MergeQueueRepairRoutesClient({
      orchestratorUrl: "http://orchestrator:3000",
      fetchImpl: async (input) => {
        calls.push(typeof input === "string" ? input : input.toString());
        return new Response(JSON.stringify({ repairRoutes: [] }), { status: 200 });
      },
    });
    await client.listRepairRoutes("org_a", "project_a");
    expect(calls[0]).toContain("repair-routes?limit=50");
  });
});
