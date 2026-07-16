// cspell:ignore mqeval mqgrp
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  MergeQueueAuthorityEvaluationsClient,
  type MergeQueueAuthorityEvaluation,
  type MergeQueueAuthorityEvaluationsListResponse,
  type MultiMemberAuthorityKind,
  type MultiMemberAuthoritySource,
} from "../src/api/mergeQueueAuthorityEvaluations.js";
import { MultiMemberAuthorityPanel } from "../src/components/mergeQueue/MultiMemberAuthorityPanel.js";

const EVALUATION = `mqeval_${"a".repeat(64)}`;
const GROUP = `mqgrp_${"b".repeat(64)}`;

function sourceFor(kind: MultiMemberAuthorityKind): MultiMemberAuthoritySource {
  if (kind === "authorized_subset") return "authority_decision";
  if (kind === "interaction_failure") return "batch_gate";
  if (kind === "flake_observation") return "quarantine";
  return "merge.signal.classified";
}

function evaluation(kind: MultiMemberAuthorityKind, index: number): MergeQueueAuthorityEvaluation {
  return {
    evaluationId: `${EVALUATION}-${index}`,
    groupId: GROUP,
    kind,
    observedAt: `2026-07-16T12:0${index}:00.000Z`,
    source: sourceFor(kind),
    sourceId: `durable-${index}`,
    nodeId: kind === "authorized_subset" ? "node-exact" : null,
    memberSetHash: kind === "authorized_subset" ? "member-set-exact" : null,
    proofReuseKey: kind === "authorized_subset" ? "proof-exact" : null,
    members: [],
    reasonCodes: [`reason-${index}`],
    findingIds: [],
    eligibleMemberIds: [],
  };
}

const ALL_KINDS: MultiMemberAuthorityKind[] = [
  "authorized_subset",
  "member_failure",
  "interaction_failure",
  "flake_observation",
  "transient_infrastructure",
  "needs_product_decision",
  "unknown_fail_closed",
];

const ALL_STATES: MergeQueueAuthorityEvaluationsListResponse = {
  latestEvaluationId: EVALUATION,
  evaluations: ALL_KINDS.map((kind, index) => evaluation(kind, index)),
};

async function render(projection?: MergeQueueAuthorityEvaluationsListResponse): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.html(MultiMemberAuthorityPanel({ projection })));
  return await (await app.request("/")).text();
}

describe("mq-2 multi-member authority dashboard surface", () => {
  it("uses discoverable list and exact-detail routes with encoded identities", async () => {
    const calls: string[] = [];
    const client = new MergeQueueAuthorityEvaluationsClient({
      orchestratorUrl: "http://orchestrator:3000",
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        if (url.includes("?limit=")) return new Response(JSON.stringify(ALL_STATES), { status: 200 });
        return new Response(JSON.stringify({ evaluation: ALL_STATES.evaluations[0] }), { status: 200 });
      },
    });

    expect(await client.listAuthorityEvaluations("org/acme", "project tanren", 7)).toEqual(ALL_STATES);
    expect(await client.getAuthorityEvaluation("org/acme", "project tanren", "mqeval/a b")).toEqual({
      evaluation: ALL_STATES.evaluations[0],
    });
    expect(calls).toEqual([
      "http://orchestrator:3000/orgs/org%2Facme/projects/project%20tanren/merge-queue/authority-evaluations?limit=7",
      "http://orchestrator:3000/orgs/org%2Facme/projects/project%20tanren/merge-queue/authority-evaluations/mqeval%2Fa%20b",
    ]);
  });

  it("visibly renders every closed consumer kind", async () => {
    const html = await render(ALL_STATES);

    expect(html).toContain("authorized · exact full node");
    expect(html).toContain("member failure · attributed");
    expect(html).toContain("interaction failure · hold");
    expect(html).toContain("flake observation · same tree");
    expect(html).toContain("infrastructure · retryable");
    expect(html).toContain("product decision required");
    expect(html).toContain("unknown · fail closed");
    for (const kind of ALL_KINDS) expect(html).toContain(`data-authority-kind="${kind}"`);
  });

  it("preserves ordered member outcomes and keeps aggregate-only findings unattributed", async () => {
    const memberFailure: MergeQueueAuthorityEvaluation = {
      ...evaluation("member_failure", 8),
      findingIds: ["finding-policy-b"],
      eligibleMemberIds: ["spec-a"],
      members: [
        {
          ordinal: 0,
          specId: "spec-a",
          runId: "run-a",
          branch: "tanren/spec-a",
          headSha: "head-a",
          disposition: "admit",
          findingIds: [],
          reasonCodes: ["independent_survivor"],
        },
        {
          ordinal: 1,
          specId: "spec-b",
          runId: null,
          branch: null,
          headSha: null,
          disposition: "exclude",
          findingIds: [],
          reasonCodes: ["audit_policy"],
        },
        {
          ordinal: 2,
          specId: "spec-c",
          runId: "run-c",
          branch: "tanren/spec-c",
          headSha: "head-c",
          disposition: "hold",
          findingIds: [],
          reasonCodes: ["depends_on_failed_member"],
        },
      ],
    };
    const html = await render({ latestEvaluationId: memberFailure.evaluationId, evaluations: [memberFailure] });

    expect(html.indexOf("spec-a")).toBeLessThan(html.indexOf("spec-b"));
    expect(html.indexOf("spec-b")).toBeLessThan(html.indexOf("spec-c"));
    expect(html).toContain("member 1 · admit");
    expect(html).toContain("member 2 · exclude");
    expect(html).toContain("member 3 · hold");
    expect(html).toContain("run · not durably linked");
    expect(html.match(/finding-policy-b/gu)).toHaveLength(1);
    expect(html).toContain("durable source · merge.signal.classified · durable-8");
  });

  it("renders unavailable and empty reads as unknown, never green", async () => {
    const unavailable = await render();
    const empty = await render({ latestEvaluationId: null, evaluations: [] });

    expect(unavailable).toContain("unknown and fail-closed");
    expect(unavailable).toContain("unavailable read is never authorization");
    expect(empty).toContain("unknown and fail-closed");
    expect(empty).toContain("empty state is never green");
    expect(unavailable).not.toContain("authorized · exact full node");
    expect(empty).not.toContain("authorized · exact full node");
  });
});
