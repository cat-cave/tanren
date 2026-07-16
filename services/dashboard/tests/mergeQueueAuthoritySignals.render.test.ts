// cspell:ignore mqeval mqgrp mqwake
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  MergeQueueAuthoritySignalsClient,
  type MergeQueueAuthoritySignalsListResponse,
} from "../src/api/mergeQueueAuthoritySignals.js";
import { AuthoritySignalPanel } from "../src/components/mergeQueue/AuthoritySignalPanel.js";

const EVALUATION = `mqeval_${"a".repeat(64)}`;
const GROUP = `mqgrp_${"b".repeat(64)}`;

const POLICY_PROJECTION: MergeQueueAuthoritySignalsListResponse = {
  latestEvaluationId: EVALUATION,
  signals: [
    {
      eventId: "42",
      observedAt: "2026-07-15T12:00:00.000Z",
      signal: {
        missionNodeId: "mq-1",
        evaluationId: EVALUATION,
        groupId: GROUP,
        signalVersion: "merge_signal.v1",
        memberIds: ["C"],
        findingIds: ["finding-p1"],
        classification: "deterministic_policy",
        reasonCode: "audit_policy",
        retryability: "non_retryable",
        wakeKey: null,
        disposition: "member_repair",
      },
    },
  ],
};

async function render(projection?: MergeQueueAuthoritySignalsListResponse): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.html(AuthoritySignalPanel({ projection })));
  return await (await app.request("/")).text();
}

describe("mq-1 authority-signal dashboard surface", () => {
  it("uses the discoverable latest collection instead of requiring an evaluation ID", async () => {
    const calls: string[] = [];
    const client = new MergeQueueAuthoritySignalsClient({
      orchestratorUrl: "http://orchestrator:3000",
      fetchImpl: async (input) => {
        calls.push(typeof input === "string" ? input : input.toString());
        return new Response(JSON.stringify(POLICY_PROJECTION), { status: 200 });
      },
    });

    expect(await client.listAuthoritySignals("org/acme", "project tanren", 7)).toEqual(POLICY_PROJECTION);
    expect(calls).toEqual([
      "http://orchestrator:3000/orgs/org%2Facme/projects/project%20tanren/merge-queue/authority-signals?limit=7",
    ]);
  });

  it("renders the latest event-backed member policy evidence", async () => {
    const html = await render(POLICY_PROJECTION);

    expect(html).toContain("authority signal classification");
    expect(html).toContain("latest evidence");
    expect(html).toContain("policy block · member-local");
    expect(html).toContain("members · <b>C</b>");
    expect(html).toContain("findings · <b>finding-p1</b>");
    expect(html).toContain("disposition · member_repair");
    expect(html).not.toContain("infrastructure signal");
  });

  it("visibly distinguishes infrastructure, product-decision, and unknown states", async () => {
    const html = await render({
      latestEvaluationId: EVALUATION,
      signals: [
        {
          eventId: "50",
          observedAt: "2026-07-15T12:01:00.000Z",
          signal: {
            missionNodeId: "mq-1",
            evaluationId: EVALUATION,
            groupId: GROUP,
            signalVersion: "merge_signal.v1",
            memberIds: [],
            findingIds: [],
            classification: "transient_infrastructure",
            reasonCode: "provider_timeout",
            retryability: "retryable",
            wakeKey: `mqwake_${"c".repeat(64)}`,
            disposition: "retry_when_ready",
          },
        },
        {
          eventId: "51",
          observedAt: "2026-07-15T12:02:00.000Z",
          signal: {
            missionNodeId: "mq-1",
            evaluationId: EVALUATION,
            groupId: GROUP,
            signalVersion: "merge_signal.v1",
            memberIds: [],
            findingIds: [],
            classification: "needs_product_decision",
            reasonCode: "hitl_pending",
            retryability: "non_retryable",
            wakeKey: `mqwake_${"d".repeat(64)}`,
            disposition: "await_product_decision",
          },
        },
        {
          eventId: "52",
          observedAt: "2026-07-15T12:03:00.000Z",
          signal: {
            missionNodeId: "mq-1",
            evaluationId: EVALUATION,
            groupId: GROUP,
            signalVersion: "merge_signal.v1",
            memberIds: [],
            findingIds: [],
            classification: "unknown_fail_closed",
            reasonCode: "untyped_evidence",
            retryability: "unknown",
            wakeKey: null,
            disposition: "hold_fail_closed",
          },
        },
      ],
    });

    expect(html).toContain("infrastructure signal · retryable");
    expect(html).toContain("product decision required");
    expect(html).toContain("unknown · fail closed");
    expect(html).toContain("reason · provider_timeout");
  });

  it("renders unavailable and empty projections as unknown, never green", async () => {
    const unavailable = await render();
    const empty = await render({ latestEvaluationId: null, signals: [] });

    expect(unavailable).toContain("remains unknown and fail-closed");
    expect(unavailable).toContain("never interpreted as healthy or transient");
    expect(empty).toContain("No classified authority signal has been recorded");
    expect(empty).toContain("remains unknown and fail-closed");
  });
});
