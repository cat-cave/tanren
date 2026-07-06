// Unit tests for `subscribeWithReconnect` (audit lane C2 findings #4-#7 — the
// four subscribers' unified reconnect helper). Over a fake `PgNotifyListener`
// (no Postgres), they prove:
//   - the initial `subscribe()` is retried UNBOUNDED with progress-spaced
//     backoff — a boot-time PG blip does not silently degrade the subscriber,
//   - a live connection-lost signal (the fake's `fireConnectionError`) re-drives
//     the subscribe (idempotent w.r.t. the handler Set on the real listener),
//   - `stop()` tears the loop down + unsubscribes exactly once,
//   - `await stop()` drains the in-flight subscribe BEFORE returning so a
//     restart cannot race a stale handler onto the shared listener (Codex RA1,
//     Bug 2 regression pin),
//   - `subscribe()` throws are ATOMIC — a repeated retry never leaks a fresh
//     handler into the underlying listener's set (Codex RA1, Bug 1 regression pin),
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
  handlerCount(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0;
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

    await handle.stop();
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

    await handle.stop();
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

    await handle.stop();
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

    await handle.stop();
    // Idempotent: a second stop() is a no-op.
    await handle.stop();

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

    // Stop before the stalled subscribe returns — do NOT await yet (the loop is
    // parked on the stalled subscribe, so `await stop()` would hang forever
    // per the Codex RA1 contract; the test resolves the stall next).
    const stopPromise = handle.stop();
    // Now let the stalled subscribe resolve — the helper must unsubscribe it
    // immediately (never install it as a live subscription).
    resolveSubscribe?.(() => {
      unsubCalled += 1;
    });
    // Awaiting `stop()` now MUST resolve — the loop's stalled subscribe just
    // completed, the loop unsub'd it and exited (Bug 2 regression pin).
    await stopPromise;

    expect(unsubCalled).toBe(1);
  });

  // Codex RA1, Bug 2 regression pin — `await stop()` DRAINS the in-flight
  // subscribe before returning. Prior to the fix, `stop()` returned
  // synchronously while the underlying `PgNotifyListener.subscribe(…)` promise
  // could still resolve (installing a handler) or throw (interacting with
  // Bug 1's handler leak) AFTER stop() observably returned — a subsequent
  // `start()` would then race a stale handler set.
  it("await stop() returns AFTER the current subscribe has resolved (Bug 2)", async () => {
    let resolveSubscribe: ((unsub: () => void) => void) | undefined;
    let subscribeReturned = false;
    let unsubCalled = 0;
    const stallingListener = {
      subscribe: (): Promise<() => void> => {
        return new Promise<() => void>((resolve) => {
          resolveSubscribe = resolve;
        });
      },
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
    expect(resolveSubscribe).toBeDefined();

    // Kick off stop() BEFORE the subscribe resolves.
    let stopResolved = false;
    const stopPromise = handle.stop().then(() => {
      stopResolved = true;
    });

    await flush();
    // stop() must NOT have resolved yet — the loop is still awaiting the
    // stalled subscribe promise.
    expect(stopResolved).toBe(false);

    // Now let the subscribe resolve — the loop unsub's and exits.
    resolveSubscribe?.(() => {
      subscribeReturned = true;
      unsubCalled += 1;
    });
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(subscribeReturned).toBe(true);
    expect(unsubCalled).toBe(1);
  });

  // Codex RA1, Bug 2 regression pin — a `await stop(); await start()`-shaped
  // sequence (running a second helper against the SAME `PgNotifyListener`
  // after draining the first) produces exactly ONE active handler on the
  // shared listener at any time. Without the drain, the first helper's
  // in-flight subscribe could still resolve into the listener's handler Set
  // AFTER `stop()` returned, coexisting with the second helper's handler for
  // a tick.
  it("await stop(); await restart on the same listener never leaves two handler sets active (Bug 2)", async () => {
    const listener = new FakeNotifyListener();

    const handleA = subscribeWithReconnect({
      listener: listener as unknown as PgNotifyListener,
      channel: CHANNEL,
      handler: () => {},
      sleep: async () => {
        await Promise.resolve();
      },
    });

    await flush();
    expect(listener.handlerCount(CHANNEL)).toBe(1);

    // Drain the first helper's loop; the drain awaits the in-flight subscribe
    // + unsub, so post-stop there is exactly zero handlers on the shared
    // listener.
    await handleA.stop();
    expect(listener.handlerCount(CHANNEL)).toBe(0);

    // A restart re-installs exactly one handler — never a lingering second one.
    const handleB = subscribeWithReconnect({
      listener: listener as unknown as PgNotifyListener,
      channel: CHANNEL,
      handler: () => {},
      sleep: async () => {
        await Promise.resolve();
      },
    });

    await flush();
    expect(listener.handlerCount(CHANNEL)).toBe(1);

    await handleB.stop();
    expect(listener.handlerCount(CHANNEL)).toBe(0);
  });

  // Codex RA1, Bug 1 regression pin — the reconnect helper's UNBOUNDED retry
  // loop must NOT leak a handler on repeated subscribe failures. Prior to the
  // Bug 1 fix in `db/src/notify.ts`, every failed `PgNotifyListener.subscribe`
  // left the handler in the underlying Set, so the retry loop grew the Set
  // unboundedly. With the fix, a real `PgNotifyListener`'s Set stays clean;
  // this test exercises the invariant end-to-end via a fake that mirrors the
  // real listener's atomicity contract.
  it("repeated subscribe failures never grow the underlying handler Set (Bug 1 x Bug 2 compose)", async () => {
    const listener = new FakeNotifyListener();
    // Fail the first three attempts before letting the fourth succeed.
    listener.failCount = 3;
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
    await flush();

    // Four subscribe attempts made, but ONLY the successful (fourth) attempt
    // installed a handler — the three failures left the handler Set unchanged.
    expect(listener.subscribeAttempts).toBe(4);
    expect(listener.handlerCount(CHANNEL)).toBe(1);

    await handle.stop();
    expect(listener.handlerCount(CHANNEL)).toBe(0);
  });
});
