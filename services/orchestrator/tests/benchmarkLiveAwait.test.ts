// Unit tests for the LIVE terminal-await seam
// (docs/roadmap/tanren-method-benchmark.md §4.2 item 2). They prove the
// production `awaitTerminal` injection resolves when a run reaches a terminal
// state, WAKES on a `tanren_run` NOTIFY (via a fake PgNotifyListener) rather than
// hot-polling, and AWAITS INDEFINITELY (no wall-clock deadline) until the run's
// real terminal state — even past the old 30-min trial timeout — all over a fake
// pool + fake listener (no Postgres).
import type pg from "pg";
import { RUN_ACTIVITY_CHANNEL } from "@tanren/db";
import { describe, expect, it } from "vitest";
import { buildLiveAwaitTerminal } from "../src/engine/benchmark/liveAwait.js";

const ORG = "org_bench";
const RUN = "run_await1";

// A fake PgNotifyListener: records subscriptions and lets a test fire a NOTIFY
// payload to the registered handler. Matches the shape buildLiveAwaitTerminal
// consumes (subscribe → handler(payload), returns an unsubscribe fn).
class FakeNotifyListener {
  readonly subscriptions: { channel: string }[] = [];
  private handlers = new Map<string, Set<(payload: string) => void>>();
  unsubscribeCount = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    this.subscriptions.push({ channel });
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => {
      this.unsubscribeCount += 1;
      set?.delete(handler);
    };
  }
  fire(channel: string, payload: string): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
}

// A fake pool whose `runs` status read returns scripted snapshots in sequence.
// Each org-scoped read consumes the next status; a single-element script repeats.
function fakePool(statuses: string[]): pg.Pool {
  let reads = 0;
  const next = (): string => statuses[Math.min(reads, statuses.length - 1)] ?? "running";
  const client = {
    query: async (sql: string) => {
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM runs WHERE run_id/u.test(sql)) {
        const status = next();
        reads += 1;
        return { rows: [{ status, outcome: status === "completed" ? "ok" : null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = { query: client.query, connect: async () => client };
  return pool as unknown as pg.Pool;
}

describe("buildLiveAwaitTerminal", () => {
  it("resolves immediately when the run is already terminal at subscribe time", async () => {
    const pool = fakePool(["completed"]);
    const listener = new FakeNotifyListener();
    const awaitTerminal = buildLiveAwaitTerminal({
      pool,
      notifyListener: listener as unknown as Parameters<typeof buildLiveAwaitTerminal>[0]["notifyListener"],
    });
    const snapshot = await awaitTerminal({ orgId: ORG, runId: RUN });
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.merged).toBe(true);
    // It subscribed to the run-activity channel and tore the subscription down.
    expect(listener.subscriptions).toEqual([{ channel: RUN_ACTIVITY_CHANNEL }]);
    expect(listener.unsubscribeCount).toBe(1);
  });

  it("wakes on a tanren_run NOTIFY for this run and resolves on the next read", async () => {
    // First read: running; after a NOTIFY wakes the loop, the second read is done.
    const pool = fakePool(["running", "completed"]);
    const listener = new FakeNotifyListener();
    const awaitTerminal = buildLiveAwaitTerminal({
      pool,
      notifyListener: listener as unknown as Parameters<typeof buildLiveAwaitTerminal>[0]["notifyListener"],
      // A long safety-net so the wake — NOT the backstop — is what advances the loop.
      safetyNetPollMs: 60_000,
    });
    const pending = awaitTerminal({ orgId: ORG, runId: RUN });
    // Let the first (running) read + park happen, then fire the run's NOTIFY.
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    listener.fire(RUN_ACTIVITY_CHANNEL, RUN);
    const snapshot = await pending;
    expect(snapshot?.status).toBe("completed");
    expect(listener.unsubscribeCount).toBe(1);
  });

  it("ignores a NOTIFY for a DIFFERENT run (filters on the run id payload)", async () => {
    const pool = fakePool(["running", "running", "completed"]);
    const listener = new FakeNotifyListener();
    const awaitTerminal = buildLiveAwaitTerminal({
      pool,
      notifyListener: listener as unknown as Parameters<typeof buildLiveAwaitTerminal>[0]["notifyListener"],
      safetyNetPollMs: 8,
    });
    const pending = awaitTerminal({ orgId: ORG, runId: RUN });
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    // A NOTIFY for another run must NOT wake this await; the safety-net backstop
    // eventually advances it to the terminal status instead.
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_other");
    const snapshot = await pending;
    expect(snapshot?.status).toBe("completed");
  });

  it("awaits INDEFINITELY (no deadline) — a run still running long past the old 30m timeout resolves on its eventual terminal state", async () => {
    // Many consecutive `running` reads stand in for a trial that runs far longer
    // than the eradicated 30-min wall-clock deadline; the seam must NOT give up
    // (no undefined-at-deadline) and must resolve once the run finally terminates.
    const pool = fakePool([...Array.from({ length: 50 }, () => "running"), "completed"]);
    const listener = new FakeNotifyListener();
    const awaitTerminal = buildLiveAwaitTerminal({
      pool,
      notifyListener: listener as unknown as Parameters<typeof buildLiveAwaitTerminal>[0]["notifyListener"],
      // Tiny safety-net cadence so the backstop drives the many reads quickly in
      // the test (it is a poll INTERVAL, not a deadline).
      safetyNetPollMs: 1,
    });
    const snapshot = await awaitTerminal({ orgId: ORG, runId: RUN });
    // It resolved on the REAL terminal state — never returned undefined-at-deadline.
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.merged).toBe(true);
    // The subscription is torn down on the success path.
    expect(listener.unsubscribeCount).toBe(1);
  });
});
