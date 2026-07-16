// gv-2 cross-process publish fence: try-lock, destroy-on-unlock-fail, fail-closed.
import { describe, expect, it } from "vitest";
import type pg from "pg";

import {
  InMemorySimulatedReviewPublishFence,
  PgAdvisorySimulatedReviewPublishFence,
  SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE,
  SimulatedReviewPublishFenceBusyError,
  simulatedReviewPublishFenceMaterial,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublishFence.js";
import { SimulatedReviewPublicationError } from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const REVIEWER = "tanren-reviewer[bot]";

const baseKey = {
  owner: "o",
  repo: "r",
  pullNumber: 1,
  headSha: HEAD,
  reviewerLogin: REVIEWER,
};

describe("gv-2 publish fence key isolation + try-advisory lock", () => {
  it("wrong head/pr/reviewer cannot share; opposing states serialize on the same material", () => {
    const a = simulatedReviewPublishFenceMaterial(baseKey);
    const b = simulatedReviewPublishFenceMaterial({ ...baseKey, headSha: OTHER_HEAD });
    const c = simulatedReviewPublishFenceMaterial({ ...baseKey, pullNumber: 2 });
    const d = simulatedReviewPublishFenceMaterial({ ...baseKey, reviewerLogin: "other" });
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(a).toContain(SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE);
    expect(a).not.toContain("approved");
  });

  it("in-memory fence serializes concurrent work on the same key (test injection only)", async () => {
    const fence = new InMemorySimulatedReviewPublishFence();
    const order: number[] = [];
    await Promise.all([
      fence.withExclusivePublish(baseKey, async () => {
        order.push(1);
        await new Promise<void>((r) => {
          setTimeout(r, 20);
        });
        order.push(2);
      }),
      fence.withExclusivePublish(baseKey, async () => {
        order.push(3);
        order.push(4);
      }),
    ]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("try-lock SQL + unlock after exception; never blocking pg_advisory_lock", async () => {
    const sqlLog: string[] = [];
    let unlocked = false;
    const client = {
      query: async (sql: string) => {
        sqlLog.push(sql);
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
        if (sql.includes("pg_advisory_unlock")) {
          unlocked = true;
          return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => client as unknown as pg.PoolClient,
    });
    await expect(
      fence.withExclusivePublish(baseKey, async () => {
        throw new Error("boom during publish");
      }),
    ).rejects.toThrow(/boom during publish/u);
    expect(sqlLog.some((s) => s.includes("pg_try_advisory_lock"))).toBe(true);
    expect(sqlLog.some((s) => s.includes("pg_advisory_lock(") && !s.includes("try"))).toBe(false);
    expect(sqlLog.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(unlocked).toBe(true);
  });

  it("try-lock false → retriable busy, zero provider work", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => client as unknown as pg.PoolClient,
    });
    let worked = false;
    await expect(
      fence.withExclusivePublish(baseKey, async () => {
        worked = true;
        return 1;
      }),
    ).rejects.toBeInstanceOf(SimulatedReviewPublishFenceBusyError);
    await expect(
      fence.withExclusivePublish(baseKey, async () => {
        worked = true;
        return 1;
      }),
    ).rejects.toThrow(/fence busy/iu);
    expect(worked).toBe(false);
    const busy = await fence
      .withExclusivePublish(baseKey, async () => 1)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(busy).toBeInstanceOf(SimulatedReviewPublicationError);
    expect((busy as SimulatedReviewPublicationError).retriable).toBe(true);
  });

  it("lock query failure is retriable and fails loud (never unfenced work)", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) throw new Error("lock denied");
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => client as unknown as pg.PoolClient,
    });
    let worked = false;
    const failure = await fence
      .withExclusivePublish(baseKey, async () => {
        worked = true;
        return 1;
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SimulatedReviewPublicationError);
    expect((failure as SimulatedReviewPublicationError).message).toMatch(/lock acquisition failed/iu);
    expect((failure as SimulatedReviewPublicationError).retriable).toBe(true);
    expect(worked).toBe(false);
  });

  it("connect failure is retriable and fails loud with zero work", async () => {
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => {
        throw new Error("pool exhausted");
      },
    });
    let worked = false;
    const failure = await fence
      .withExclusivePublish(baseKey, async () => {
        worked = true;
        return 1;
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SimulatedReviewPublicationError);
    expect((failure as SimulatedReviewPublicationError).message).toMatch(/could not pin a pool client/iu);
    expect((failure as SimulatedReviewPublicationError).retriable).toBe(true);
    expect(worked).toBe(false);
  });

  it("post-success unlock failure is retriable, destroys client, and does not return it healthy", async () => {
    const releases: Array<boolean | Error | undefined> = [];
    const client = {
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
        if (sql.includes("pg_advisory_unlock")) throw new Error("connection lost on unlock");
        return { rows: [], rowCount: 0 };
      },
      release: (destroy?: boolean | Error) => {
        releases.push(destroy);
      },
    };
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => client as unknown as pg.PoolClient,
    });
    const failure = await fence
      .withExclusivePublish(baseKey, async () => "ok")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SimulatedReviewPublicationError);
    expect((failure as SimulatedReviewPublicationError).message).toMatch(/unlock failed after successful work/iu);
    expect((failure as SimulatedReviewPublicationError).retriable).toBe(true);
    expect(releases).toEqual([true]);
  });

  it("provider error + unlock failure: preserves publication error and destroys client", async () => {
    const releases: Array<boolean | Error | undefined> = [];
    const client = {
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
        if (sql.includes("pg_advisory_unlock")) throw new Error("unlock boom");
        return { rows: [], rowCount: 0 };
      },
      release: (destroy?: boolean | Error) => {
        releases.push(destroy);
      },
    };
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => client as unknown as pg.PoolClient,
    });
    await expect(
      fence.withExclusivePublish(baseKey, async () => {
        throw new Error("forge 502");
      }),
    ).rejects.toThrow(/forge 502/u);
    await expect(
      fence.withExclusivePublish(baseKey, async () => {
        throw new Error("forge 502");
      }),
    ).rejects.toThrow(/unlock failed/iu);
    expect(releases).toEqual([true, true]);
  });

  it("two clients: holder works; contender gets busy with zero I/O (no blocking wait)", async () => {
    let held = false;
    let contenderWorked = false;
    const makeClient = () => ({
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          if (held) return { rows: [{ acquired: false }], rowCount: 1 };
          held = true;
          return { rows: [{ acquired: true }], rowCount: 1 };
        }
        if (sql.includes("pg_advisory_unlock")) {
          held = false;
          return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    });
    const fence = new PgAdvisorySimulatedReviewPublishFence({
      connect: async () => makeClient() as unknown as pg.PoolClient,
    });
    const holder = fence.withExclusivePublish(baseKey, async () => {
      await new Promise<void>((r) => {
        setTimeout(r, 30);
      });
      return "held";
    });
    // Contender while holder still inside work → try-lock false → busy, zero work.
    await new Promise<void>((r) => {
      setTimeout(r, 5);
    });
    await expect(
      fence.withExclusivePublish(baseKey, async () => {
        contenderWorked = true;
        return "nope";
      }),
    ).rejects.toBeInstanceOf(SimulatedReviewPublishFenceBusyError);
    expect(contenderWorked).toBe(false);
    expect(await holder).toBe("held");
    // After release, redrive acquires and runs.
    const again = await fence.withExclusivePublish(baseKey, async () => "redrive");
    expect(again).toBe("redrive");
  });
});
