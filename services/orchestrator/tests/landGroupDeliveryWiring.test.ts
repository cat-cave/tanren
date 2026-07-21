// mq-13 — the LandGroupDeliveryLoop is driven FIRST in PostMergeSubscriber.runChain, and its
// failure is ISOLATED (never suppresses the issue / delivery / seal watchers). Over a fake
// PgNotifyListener + recording watchers (no Postgres).

import { RUN_ACTIVITY_CHANNEL } from "@tanren/db";
import { describe, expect, it, vi } from "vitest";
import { PostMergeSubscriber } from "../src/engine/postMerge/subscriber.js";
import type { PostMergeWatcher } from "../src/engine/postMerge/watcher.js";

class FakeNotifyListener {
  private handlers = new Map<string, Set<(payload: string) => void>>();
  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }
  onConnectionError(): () => void {
    return () => {
      /* no live-drop handling in this fake */
    };
  }
  fire(channel: string, payload: string): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
}

class RecordingWatcher {
  constructor(
    private readonly order: string[],
    private readonly label: string,
    private readonly fail = false,
  ) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async check(): Promise<void> {
    this.order.push(this.label);
    if (this.fail) throw new Error(`${this.label} blew up`);
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

function buildSubscriber(order: string[], opts: { landGroupFails?: boolean } = {}) {
  const listener = new FakeNotifyListener();
  const sub = new PostMergeSubscriber({
    pool: {} as never,
    secrets: {} as never,
    githubHttp: {} as never,
    notifyListener: listener as never,
    watcher: new RecordingWatcher(order, "issue") as unknown as PostMergeWatcher,
    landGroupDeliveryLoop: new RecordingWatcher(order, "land-group-delivery", opts.landGroupFails === true),
    deliveryDriver: new RecordingWatcher(order, "delivery"),
    mergeTrainArtifactWatcher: new RecordingWatcher(order, "merge-train"),
    designDeliveryCoordinator: new RecordingWatcher(order, "design-delivery"),
  });
  return { sub, listener };
}

describe("LandGroupDeliveryLoop wiring in runChain", () => {
  it("drives the land-group delivery loop FIRST, before the issue / delivery / seal / join watchers", async () => {
    const order: string[] = [];
    const { sub, listener } = buildSubscriber(order);
    await sub.start();
    await flush();
    listener.fire(RUN_ACTIVITY_CHANNEL, "run-tail");
    await flush();
    expect(order).toEqual(["land-group-delivery", "issue", "delivery", "merge-train", "design-delivery"]);
    await sub.stop();
  });

  it("ISOLATES a land-group delivery failure — the issue / delivery / seal / join watchers still run", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      /* swallow the isolation log */
    });
    const order: string[] = [];
    const { sub, listener } = buildSubscriber(order, { landGroupFails: true });
    await sub.start();
    await flush();
    listener.fire(RUN_ACTIVITY_CHANNEL, "run-tail");
    await flush();
    expect(order).toEqual(["land-group-delivery", "issue", "delivery", "merge-train", "design-delivery"]);
    await sub.stop();
    errorSpy.mockRestore();
  });
});
