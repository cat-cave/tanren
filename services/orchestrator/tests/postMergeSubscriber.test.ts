// Unit tests for the post-merge watcher subscriber (tempering.md dim A): the
// long-lived listener that drives the PostMergeWatcher on every run-activity
// notification. Over a fake PgNotifyListener + a recording watcher (no Postgres),
// they prove the EVENT-DRIVEN TRIGGER fires the watcher per run, that per-run
// checks are coalesced (a storm collapses to in-flight + one re-check), and that
// stop() unsubscribes + a check failure never throws into the notify pump.

import { RUN_ACTIVITY_CHANNEL } from "@tanren/db";
import { describe, expect, it, vi } from "vitest";
import { PostMergeSubscriber } from "../src/engine/postMerge/subscriber.js";
import type { PostMergeWatcher } from "../src/engine/postMerge/watcher.js";

class FakeNotifyListener {
  private handlers = new Map<string, Set<(payload: string) => void>>();
  private connErrObs = new Set<() => void>();
  unsubscribeCount = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
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
  // The subscribeWithReconnect helper registers here so a live drop drives re-subscribe.
  onConnectionError(cb: () => void): () => void {
    this.connErrObs.add(cb);
    return () => this.connErrObs.delete(cb);
  }
  fire(channel: string, payload: string): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
}

/** A recording watcher: records the runIds it was asked to check. */
class RecordingWatcher {
  readonly checks: string[] = [];
  constructor(
    private readonly onCheck?: (runId: string) => Promise<void>,
    private readonly fail = false,
  ) {}
  async check(runId: string): Promise<void> {
    this.checks.push(runId);
    if (this.onCheck !== undefined) await this.onCheck(runId);
    if (this.fail) throw new Error("watcher blew up");
  }
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
const flush = async (): Promise<void> => {
  await tick();
  await tick();
};

function makeSubscriber(watcher: RecordingWatcher, listener: FakeNotifyListener): PostMergeSubscriber {
  return new PostMergeSubscriber({
    pool: {} as never,
    secrets: {} as never,
    githubHttp: {} as never,
    notifyListener: listener as never,
    watcher: watcher as unknown as PostMergeWatcher,
  });
}

describe("PostMergeSubscriber", () => {
  it("a run-activity notification drives the watcher for that run", async () => {
    const watcher = new RecordingWatcher();
    const listener = new FakeNotifyListener();
    const sub = makeSubscriber(watcher, listener);
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_merged");
    await flush();

    expect(watcher.checks).toEqual(["run_merged"]);
    sub.stop();
  });

  it("an empty run id is ignored", async () => {
    const watcher = new RecordingWatcher();
    const listener = new FakeNotifyListener();
    const sub = makeSubscriber(watcher, listener);
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "");
    await flush();

    expect(watcher.checks).toEqual([]);
    sub.stop();
  });

  it("coalesces concurrent triggers for one run into a single re-check", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstCheck = true;
    const watcher = new RecordingWatcher(async () => {
      if (firstCheck) {
        firstCheck = false;
        await gate;
      }
    });
    const listener = new FakeNotifyListener();
    const sub = makeSubscriber(watcher, listener);
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_x");
    await flush();
    // Two more while the first check is parked.
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_x");
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_x");
    await flush();

    release();
    await flush();

    // Exactly two checks: the original + ONE coalesced re-check (not three).
    expect(watcher.checks).toEqual(["run_x", "run_x"]);
    sub.stop();
  });

  it("a check failure is non-fatal: logged, never thrown into the notify pump", async () => {
    const watcher = new RecordingWatcher(undefined, true);
    const listener = new FakeNotifyListener();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = makeSubscriber(watcher, listener);
    await sub.start();
    await flush();

    expect(() => listener.fire(RUN_ACTIVITY_CHANNEL, "run_boom")).not.toThrow();
    await flush();

    expect(watcher.checks).toEqual(["run_boom"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    sub.stop();
  });

  it("stop() unsubscribes from the bus", async () => {
    const listener = new FakeNotifyListener();
    const sub = makeSubscriber(new RecordingWatcher(), listener);
    await sub.start();
    await flush();
    sub.stop();
    expect(listener.unsubscribeCount).toBe(1);
  });
});
