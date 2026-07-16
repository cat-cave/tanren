// gv-2 cross-process publish fence: key isolation + session advisory lock proofs.
import { describe, expect, it } from "vitest";
import type pg from "pg";

import {
  InMemorySimulatedReviewPublishFence,
  PgAdvisorySimulatedReviewPublishFence,
  SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE,
  simulatedReviewPublishFenceMaterial,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublishFence.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const REVIEWER = "tanren-reviewer[bot]";

describe("gv-2 publish fence key isolation + advisory lock SQL", () => {
  it("wrong key/head/pr cannot share fence material", () => {
    const base = {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      headSha: HEAD,
      reviewerLogin: REVIEWER,
      state: "approved" as const,
    };
    const a = simulatedReviewPublishFenceMaterial(base);
    const b = simulatedReviewPublishFenceMaterial({ ...base, headSha: OTHER_HEAD });
    const c = simulatedReviewPublishFenceMaterial({ ...base, pullNumber: 2 });
    const d = simulatedReviewPublishFenceMaterial({ ...base, reviewerLogin: "other" });
    const e = simulatedReviewPublishFenceMaterial({ ...base, state: "changes_requested" });
    expect(new Set([a, b, c, d, e]).size).toBe(5);
    expect(a).toContain(SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE);
  });

  it("in-memory fence serializes concurrent work on the same key", async () => {
    const fence = new InMemorySimulatedReviewPublishFence();
    const key = {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      headSha: HEAD,
      reviewerLogin: REVIEWER,
      state: "approved" as const,
    };
    const order: number[] = [];
    await Promise.all([
      fence.withExclusivePublish(key, async () => {
        order.push(1);
        await new Promise<void>((r) => {
          setTimeout(r, 20);
        });
        order.push(2);
      }),
      fence.withExclusivePublish(key, async () => {
        order.push(3);
        order.push(4);
      }),
    ]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("advisory lock SQL uses session lock + unlock and releases after exception", async () => {
    const sqlLog: string[] = [];
    let unlocked = false;
    const client = {
      query: async (sql: string) => {
        sqlLog.push(sql);
        if (sql.includes("pg_advisory_unlock")) unlocked = true;
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => client as unknown as pg.PoolClient,
    });
    const key = {
      owner: "o",
      repo: "r",
      pullNumber: 7,
      headSha: HEAD,
      reviewerLogin: REVIEWER,
      state: "approved" as const,
    };
    await expect(
      fence.withExclusivePublish(key, async () => {
        throw new Error("boom during publish");
      }),
    ).rejects.toThrow(/boom during publish/u);
    expect(sqlLog.some((s) => s.includes("pg_advisory_lock"))).toBe(true);
    expect(sqlLog.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(unlocked).toBe(true);
  });

  it("lock acquisition failure fails loud (never unfenced work)", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes("pg_advisory_lock")) throw new Error("lock denied");
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => client as unknown as pg.PoolClient,
    });
    let worked = false;
    await expect(
      fence.withExclusivePublish(
        {
          owner: "o",
          repo: "r",
          pullNumber: 1,
          headSha: HEAD,
          reviewerLogin: REVIEWER,
          state: "approved",
        },
        async () => {
          worked = true;
          return 1;
        },
      ),
    ).rejects.toThrow(/lock acquisition failed/iu);
    expect(worked).toBe(false);
  });

  it("two pool clients: second waits until first unlocks (mock serial clients)", async () => {
    let held = false;
    let waiters = 0;
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((r) => {
      releaseWait = r;
    });
    const makeClient = () => ({
      query: async (sql: string) => {
        if (sql.includes("pg_advisory_lock")) {
          if (held) {
            waiters += 1;
            await waitGate;
          }
          held = true;
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("pg_advisory_unlock")) {
          held = false;
          releaseWait();
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    });
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => makeClient() as unknown as pg.PoolClient,
    });
    const key = {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      headSha: HEAD,
      reviewerLogin: REVIEWER,
      state: "approved" as const,
    };
    const order: string[] = [];
    await Promise.all([
      fence.withExclusivePublish(key, async () => {
        order.push("a-start");
        await new Promise<void>((r) => {
          setTimeout(r, 15);
        });
        order.push("a-end");
      }),
      fence.withExclusivePublish(key, async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    expect(waiters).toBeGreaterThanOrEqual(1);
  });
});
