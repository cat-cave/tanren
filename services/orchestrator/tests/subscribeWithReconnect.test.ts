// Unit tests for `subscribeWithReconnect` (audit lane C2 findings #4-#7 — the
// four subscribers' unified reconnect helper). Over a fake `PgNotifyListener`
// (no Postgres), they prove:
//   - the initial `subscribe()` is retried UNBOUNDED with progress-spaced
//     backoff — a boot-time PG blip does not silently degrade the subscriber,
//   - a live connection-lost signal (the fake's `fireConnectionError`) re-drives
//     the subscribe (idempotent w.r.t. the handler Set on the real listener),
//   - `stop()` tears the loop down + unsubscribes exactly once,
//   - the progress-spaced backoff shape is a legitimate cadence (1s → 2s → 4s
//     → 8s → 16s → 30s capped), not a give-up budget — the timeout-eradication
//     lint at `scripts/check-architecture-timeouts.mjs` blesses this shape.
//
// A note on the timeout doctrine: the helper never uses a `MAX_ATTEMPTS`,
// `AbortSignal.timeout`, or a `Promise.race` kill. Tests inject a manual
// `sleep` seam so a paced retry loop drives via a controllable deferred; no
// real timers are needed.

import { describe, expect, it, vi } from "vitest";
import type { NotifyHandler, PgNotifyListener } from "@tanren/db";
import { subscribeReconnectBackoffMs, subscribeWithReconnect } from "../src/engine/db/notifySubscriber.js";

const CHANNEL = "tanren_test";

/**
 * A fake `PgNotifyListener` whose `subscribe()` can be scripted to throw on the
 * first N attempts, and whose `onConnectionError` fires all registered
 * observers when a test triggers `fireConnectionError`.
 */
class FakeNotifyListener {
  private handlers = new Map<string, Set<NotifyHandler>>();
  private connectionErrorHandlers = new Set<() => void>();
  subscribeAttempts = 0;
  unsubscribeCount = 0;
  /** How many times `subscribe` should throw before succeeding. Reset to 0 to succeed. */
  failCount = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(channel: string, handler: NotifyHandler): Promise<() => void> {
    this.subscribeAttempts += 1;
    if (this.failCount > 0) {
      this.failCount -= 1;
      throw new Error("subscribe transient failure");
    }
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
  onConnectionError(callback: () => void): () => void {
    this.connectionErrorHandlers.add(callback);
    return () => {
      this.connectionErrorHandlers.delete(callback);
    };
  }
  fireConnectionError(): void {
    for (const cb of this.connectionErrorHandlers) cb();
  }
  fire(channel: string, payload: string): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
  hasHandler(channel: string): boolean {
    return (this.handlers.get(channel)?.size ?? 0) > 0;
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};

describe("subscribeReconnectBackoffMs", () => {
  it("grows progressively from 1s to a 30s cap — cadence, not a give-up budget", () => {
    // 1-indexed: attempt 1 → 1s, 2 → 2s, 3 → 4s, 4 → 8s, 5 → 16s, 6+ → 30s cap.
    expect(subscribeReconnectBackoffMs(1)).toBe(1_000);
    expect(subscribeReconnectBackoffMs(2)).toBe(2_000);
    expect(subscribeReconnectBackoffMs(3)).toBe(4_000);
    expect(subscribeReconnectBackoffMs(4)).toBe(8_000);
    expect(subscribeReconnectBackoffMs(5)).toBe(16_000);
    // The cap is a legitimate widening cadence — an operator still sees the loop
    // ticking on a persistent outage (one log line per 30s), never floods.
    expect(subscribeReconnectBackoffMs(6)).toBe(30_000);
    expect(subscribeReconnectBackoffMs(100)).toBe(30_000);
  });
});

describe("subscribeWithReconnect", () => {
  it("retries the initial subscribe until it succeeds (unbounded, progress-spaced)", async () => {
    const listener = new FakeNotifyListener();
    // Fail the first three attempts, then succeed on the fourth.
    listener.failCount = 3;
    const sleeps: number[] = [];
    const sleep = vi.fn<(ms: number) => Promise<void>>(async (ms) => {
      sleeps.push(ms);
      // Resolve on the microtask so the loop rolls forward instantly under the test.
      await Promise.resolve();
    });
    const onSubscribed = vi.fn<() => void>();
    const seen: string[] = [];
    const handle = subscribeWithReconnect({
      listener: listener as unknown as PgNotifyListener,
      channel: CHANNEL,
      handler: (payload) => {
        seen.push(payload);
      },
      sleep,
      onSubscribed,
    });

    // Let the retry loop churn through all four attempts.
    await flush();
    await flush();

    expect(listener.subscribeAttempts).toBe(4);
    // Three cadence sleeps between four attempts (1s → 2s → 4s), then success.
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(onSubscribed).toHaveBeenCalledTimes(1);

    // The successful subscribe DELIVERED — a notification reaches the handler.
    listener.fire(CHANNEL, "payload_1");
    expect(seen).toEqual(["payload_1"]);

    handle.stop();
    expect(listener.unsubscribeCount).toBe(1);
  });

  it("re-drives the subscribe when the pg client emits `error` (connection lost)", async () => {
    const listener = new FakeNotifyListener();
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const onSubscribed = vi.fn<() => void>();
    const seen: string[] = [];
    const handle = subscribeWithReconnect({
      listener: listener as unknown as PgNotifyListener,
      channel: CHANNEL,
      handler: (payload) => {
        seen.push(payload);
      },
      sleep,
      onSubscribed,
    });

    await flush();
    expect(listener.subscribeAttempts).toBe(1);
    expect(onSubscribed).toHaveBeenCalledTimes(1);

    // The pg client dropped: fake the wake signal. The helper drops the stale
    // unsubscribe and re-drives its subscribe loop.
    listener.fireConnectionError();
    await flush();

    // Re-subscribe fired — the helper transitioned back through the retry path.
    expect(listener.subscribeAttempts).toBe(2);
    expect(onSubscribed).toHaveBeenCalledTimes(2);
    // No retry sleep because the second attempt succeeded first-try.
    expect(sleep).not.toHaveBeenCalled();

    // A notification on the re-subscribed handler still delivers.
    listener.fire(CHANNEL, "payload_after_reconnect");
    expect(seen).toEqual(["payload_after_reconnect"]);

    handle.stop();
  });

  it("retries with progress-spaced backoff when the reconnect itself fails", async () => {
    const listener = new FakeNotifyListener();
    const sleeps: number[] = [];
    const sleep = vi.fn<(ms: number) => Promise<void>>(async (ms) => {
      sleeps.push(ms);
      await Promise.resolve();
    });
    const handle = subscribeWithReconnect({
      listener: listener as unknown as PgNotifyListener,
      channel: CHANNEL,
      handler: () => {},
      sleep,
    });

    await flush();
    expect(listener.subscribeAttempts).toBe(1);

    // Drop the connection AND fail the next two subscribe attempts (a broken db
    // that has not yet recovered) — the helper stays in retry mode with paced
    // backoff, never giving up.
    listener.failCount = 2;
    listener.fireConnectionError();
    await flush();
    await flush();
    await flush();

    // Four total attempts: the initial success + one after fireConnectionError,
    // which fails, then two more failures + a success.
    expect(listener.subscribeAttempts).toBe(4);
    // Each failure spaces the next attempt: attempts 2/3 fail (attempt count
    // resets to 0 on the previous success, so post-reconnect attempts are
    // 1-indexed anew — 1s, 2s).
    expect(sleeps).toEqual([1_000, 2_000]);

    handle.stop();
  });

  it("stop() tears down the loop and unsubscribes exactly once", async () => {
    const listener = new FakeNotifyListener();
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const handle = subscribeWithReconnect({
      listener: listener as unknown as PgNotifyListener,
      channel: CHANNEL,
      handler: () => {},
      sleep,
    });

    await flush();
    expect(listener.subscribeAttempts).toBe(1);

    handle.stop();
    // Idempotent: a second stop() is a no-op.
    handle.stop();

    expect(listener.unsubscribeCount).toBe(1);
    // A post-stop connection wake is ignored (no fresh subscribe).
    listener.fireConnectionError();
    await flush();
    expect(listener.subscribeAttempts).toBe(1);
  });

  it("does not install a stale subscription when stop() races the initial subscribe", async () => {
    // Stall the first `subscribe()` so `stop()` runs mid-flight; the helper must
    // still unsubscribe the eventual subscription (never install it as live).
    let subscribeAttempts = 0;
    let resolveSubscribe: ((unsub: () => void) => void) | undefined;
    let unsubCalled = 0;
    const stallingListener = {
      subscribe: (): Promise<() => void> => {
        subscribeAttempts += 1;
        return new Promise<() => void>((resolve) => {
          resolveSubscribe = resolve;
        });
      },
      // The helper registers a disconnect callback synchronously — the fake
      // returns a real unsubscribe closure that no-ops (nothing to observe here).
      onConnectionError: () => () => {},
    } satisfies Pick<PgNotifyListener, "subscribe" | "onConnectionError">;

    const handle = subscribeWithReconnect({
      listener: stallingListener as unknown as PgNotifyListener,
      channel: CHANNEL,
      handler: () => {},
      sleep: async () => {
        await Promise.resolve();
      },
    });

    await flush();
    expect(subscribeAttempts).toBe(1);

    // Stop before the stalled subscribe returns.
    handle.stop();
    // Now let the stalled subscribe resolve — the helper must unsubscribe it
    // immediately (never install it as a live subscription).
    resolveSubscribe?.(() => {
      unsubCalled += 1;
    });
    await flush();

    expect(unsubCalled).toBe(1);
  });
});
