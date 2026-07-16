import { runWithJobOrgId } from "@tanren/db";
import { describe, expect, it, vi } from "vitest";

import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { EventStore, PriorEventInput } from "../src/engine/eventStore.js";
import { HttpRunStateWriter } from "../src/engine/worker/httpRunStateWriter.js";
import { pollReviewForRun } from "../src/engine/workflow/reviewMerge/reviewPolling.js";
import {
  durableSimulatedReviewIntentRepository,
  PgSimulatedReviewIntentRepository,
} from "../src/engine/workflow/reviewMerge/simulatedReviewIntent.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { fakeMergeWriter, ReviewMergePool, unusedHttp } from "./reviewMerge.fixtures.js";

const HEAD = "a".repeat(40);
const KEY = `run_1:simulated-review-intent:${HEAD}`;

describe("gv-2 production durable-intent composition", () => {
  it("fails closed for append-only stores instead of creating process-local memory", () => {
    const append = vi.fn<() => Promise<void>>(async () => {});
    const appendOnly: EventStore = { append };

    expect(() => durableSimulatedReviewIntentRepository({ query: vi.fn<() => void>() } as never, appendOnly)).toThrow(
      /durable EventStore appendPriorIfAbsent seam/iu,
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("accepts a structural keyed writer without instanceof PgEventStore inference", () => {
    const writer: EventStore = {
      append: async () => {},
      appendPriorIfAbsent: async () => true,
    };

    expect(durableSimulatedReviewIntentRepository({ query: vi.fn<() => void>() } as never, writer)).toBeInstanceOf(
      PgSimulatedReviewIntentRepository,
    );
  });

  it("canonical polling fails before Answerer or forge I/O when its writer is append-only", async () => {
    const pool = new ReviewMergePool("direct_merge", "open", "simulated");
    const writer = fakeMergeWriter(pool, new FakeEventStore());
    let answererCalls = 0;
    let forgeCalls = 0;

    await expect(
      pollReviewForRun({
        pool: pool.asPgPool(),
        runStateWriter: writer,
        secrets: new FakeSecretStore(),
        githubHttp: unusedHttp(),
        runId: "run_1",
        reviewProbe: {
          markReady: async () => {
            forgeCalls += 1;
          },
          fetchVerdict: async () => {
            forgeCalls += 1;
            return { verdict: "pending" };
          },
        },
        simulatedReviewer: (() => {
          answererCalls += 1;
          throw new Error("Answerer must not be constructed");
        }) as never,
        simulatedReviewContext: {
          specTitle: "Spec",
          specDescription: "Description",
          acceptanceCriteria: ["works"],
        },
      }),
    ).rejects.toThrow(/durable EventStore appendPriorIfAbsent seam/iu);
    expect(answererCalls).toBe(0);
    expect(forgeCalls).toBe(0);
    expect(pool.tasks).toHaveLength(0);
  });

  it("HttpRunStateWriter preserves the exact idempotency key across the control-plane seam", async () => {
    const requests: unknown[] = [];
    const writer = new HttpRunStateWriter("https://control.internal", async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(JSON.stringify({ inserted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const input: PriorEventInput<"review.simulated_intent"> = {
      runId: "run_1",
      projectId: "project_1",
      orgId: "org_1",
      eventType: "review.simulated_intent",
      idempotencyKey: KEY,
      payload: {
        headSha: HEAD,
        state: "approved",
        event: "APPROVE",
        body: "approved\ntanren-simulated-review:v1:approved",
        message: "approved",
        reviewerLogin: "reviewer-bot",
        marker: "tanren-simulated-review:v1:approved",
      },
    };

    await expect(runWithJobOrgId("org_1", () => writer.appendPriorIfAbsent(input))).resolves.toBe(true);
    expect(requests).toEqual([expect.objectContaining({ idempotencyKey: KEY, orgId: "org_1" })]);
  });
});
