// subscribeWithReconnect — the shared LISTEN/NOTIFY subscribe-with-reconnect
// helper (audit lane C2 findings #4-#7). Four long-lived subscribers used to
// wear the identical no-reconnect boot-time failure pattern: on a boot-time PG
// blip the initial `PgNotifyListener.subscribe(…)` throws, the caller
// `log.error`s once, and the subscription silently degrades for the whole
// process lifetime — every real-run consequence a silent drift (DagWalker →
// periodic backstop cadence, MergeCoordinator → manual triggers only, PostMerge
// deploy watcher → merged runs stay `triggered-but-unverified`, notification
// dispatch → the "never silently drop a fail-severity event" invariant
// collapses).
//
// The fix is a single helper that:
//   1. Retries the initial subscribe UNBOUNDED with progress-spaced backoff. No
//      `MAX_ATTEMPTS`, no `AbortSignal.timeout`, no `Promise.race` kill — cadence
//      only, per the timeout-eradication doctrine (see
//      `docs/roadmap/timeout-eradication.md` and
//      `scripts/check-architecture-timeouts.mjs`). Bond to the doctrine's
//      `retryUntilConverged` primitive by shape: the retry has no cap and never
//      escalates on a bare pg connection blip (there is no human decision that
//      unblocks a boot-time db outage — infra recovers on its own; the loop
//      keeps going until it does).
//   2. Re-drives the subscribe when the underlying pg client's `error` fires.
//      The `PgNotifyListener` already reconnects + re-LISTENs internally, and
//      that recovery is the primary path — but that reconnect can itself fail
//      (see the `reconnect() { try … catch {} }` at `db/src/notify.ts`), which
//      leaves the listener DEAD until a fresh subscribe. This helper opts in
//      via `PgNotifyListener.onConnectionError(…)` so the drop drives a
//      subscribe re-attempt; a subsequent successful reconnect makes it a
//      cheap idempotent no-op, and a still-broken reconnect drops us back into
//      the same UNBOUNDED progress-spaced retry loop until the db comes back.
//   3. Emits a structured log per attempt (bound `component`) so an operator
//      can watch the loop. Spacing widens so a persistent outage does not
//      flood the log stream on a tight failure cadence.
//   4. Preserves each subscriber's business logic: the helper drives connect +
//      reconnect only; each caller registers its own notify handlers (a bare
//      `NotifyHandler` per channel).

import type { NotifyHandler, PgNotifyListener } from "@tanren/db";
import { createLogger, type Logger } from "../observability/logger.js";

const defaultLog = createLogger("notify-subscriber");

/**
 * Progress-spaced backoff between subscribe attempts (a paced cadence, NEVER a
 * give-up budget). Grows 1s → 2s → 4s → 8s → 16s → 30s (capped) so a persistent
 * outage does not flood the log stream on a tight failure cadence — the loop
 * itself is UNBOUNDED (see doctrine at `scripts/check-architecture-timeouts.mjs`).
 * `attemptCount` is 1-indexed: 1 → 1s, 2 → 2s, …, 5+ → 30s.
 */
export function subscribeReconnectBackoffMs(attemptCount: number): number {
  const shift = Math.max(0, Math.min(attemptCount - 1, 5));
  return Math.min(30_000, 1_000 * 2 ** shift);
}

export interface SubscribeWithReconnectDeps {
  /** The shared LISTEN connection to subscribe against. */
  listener: PgNotifyListener;
  /** The NOTIFY channel name (e.g. `RUN_ACTIVITY_CHANNEL`). */
  channel: string;
  /** The caller's payload handler (fired for every notification on `channel`). */
  handler: NotifyHandler;
  /**
   * A logger bound to the caller's subsystem — the helper logs each
   * subscribe / reconnect attempt against it so the loop is observable per
   * subsystem. Defaults to the helper's own `notify-subscriber` component.
   */
  logger?: Logger;
  /**
   * Test seam: replaces the real `setTimeout`-based sleep between subscribe
   * attempts. Production uses a bare `setTimeout` (see {@link defaultSleep}).
   */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: fired after every successful subscribe (initial + re-subscribe). */
  onSubscribed?: () => void;
  /** Test seam: read the current attempt count (1-indexed) after a subscribe result. */
  onAttempt?: (attemptCount: number) => void;
}

/** The running helper handle. `stop()` tears down the loop + the current subscription. */
export interface SubscribeWithReconnectHandle {
  /** Stop the retry loop + unsubscribe from `PgNotifyListener`. Idempotent. */
  stop(): void;
}

/**
 * Subscribe to a NOTIFY channel with UNBOUNDED reconnect. The initial
 * `subscribe()` is retried with progress-spaced backoff until it succeeds; the
 * underlying pg client's connection-error signal drives a re-subscribe (which
 * is idempotent w.r.t. the `PgNotifyListener` handler Set, so a successful
 * internal reconnect makes it a cheap no-op, and a still-broken reconnect
 * feeds the same retry loop). Returns a handle that stops the loop + drops
 * the current subscription on `stop()`.
 */
export function subscribeWithReconnect(deps: SubscribeWithReconnectDeps): SubscribeWithReconnectHandle {
  const log = deps.logger ?? defaultLog;
  const sleep = deps.sleep ?? defaultSleep;
  let stopped = false;
  let currentUnsub: (() => void) | undefined;
  // The wake pulse the retry loop parks on after a successful subscribe. Set
  // when the loop enters the post-subscribe wait; fired by the disconnect
  // callback (below) or by `stop()`.
  let wakeReconnect: (() => void) | undefined;

  // Register the connection-error hook eagerly (before the first subscribe
  // attempt) so a drop while the FIRST subscribe was in flight still drives a
  // re-attempt. The listener isolates each observer (it swallows throws), so
  // this cannot poison the pump.
  const disconnectUnsub = deps.listener.onConnectionError(() => {
    if (stopped) return;
    log.info("notify connection lost — re-driving subscription", { channel: deps.channel });
    // The stale unsubscribe closure was captured over the dead client's
    // LISTEN; drop it so a subsequent stop() does not try to UNLISTEN on a
    // released client. The next successful subscribe will hand back a fresh one.
    currentUnsub = undefined;
    wakeReconnect?.();
    wakeReconnect = undefined;
  });

  void runLoop({
    deps,
    log,
    sleep,
    isStopped: () => stopped,
    setCurrentUnsub: (unsub) => {
      currentUnsub = unsub;
    },
    parkForReconnect: () =>
      new Promise<void>((resolve) => {
        if (stopped) {
          resolve();
          return;
        }
        wakeReconnect = resolve;
      }),
  });

  return {
    stop(): void {
      stopped = true;
      disconnectUnsub();
      wakeReconnect?.();
      wakeReconnect = undefined;
      currentUnsub?.();
      currentUnsub = undefined;
    },
  };
}

interface LoopHooks {
  deps: SubscribeWithReconnectDeps;
  log: Logger;
  sleep: (ms: number) => Promise<void>;
  isStopped: () => boolean;
  setCurrentUnsub: (unsub: (() => void) | undefined) => void;
  parkForReconnect: () => Promise<void>;
}

/**
 * The UNBOUNDED subscribe/reconnect loop. Each iteration either:
 *   - subscribes successfully → parks on the reconnect wake pulse (returns when
 *     the disconnect callback fires or `stop()` is invoked),
 *   - fails to subscribe → logs the failure + sleeps `subscribeReconnectBackoffMs`
 *     of paced cadence, then loops.
 *
 * There is NO attempt cap, NO wall-clock deadline. The `while` guard is
 * `!isStopped()` — a plain lifetime bound, not a give-up counter, which the
 * timeout-eradication lint at `scripts/check-architecture-timeouts.mjs`
 * blesses (it flags `< max*Attempts` / `< maxPolls` shapes, not lifetime
 * checks). The `stop()` boundary is the ONLY termination.
 */
async function runLoop(hooks: LoopHooks): Promise<void> {
  let attemptCount = 0;
  while (!hooks.isStopped()) {
    attemptCount += 1;
    hooks.deps.onAttempt?.(attemptCount);
    const unsub = await trySubscribeOnce(hooks, attemptCount);
    if (unsub === undefined) {
      // Failure: pace by the progress-spaced backoff (cadence, NEVER a deadline)
      // and loop UNBOUNDED — a boot-time PG blip resolves when the db recovers.
      const delayMs = subscribeReconnectBackoffMs(attemptCount);
      hooks.log.info("notify subscribe pending — retrying after progress-spaced backoff", {
        channel: hooks.deps.channel,
        attempt: attemptCount,
        delayMs,
      });
      await hooks.sleep(delayMs);
      continue;
    }
    if (hooks.isStopped()) {
      unsub();
      return;
    }
    hooks.setCurrentUnsub(unsub);
    hooks.log.debug("notify subscribed", { channel: hooks.deps.channel, attempt: attemptCount });
    hooks.deps.onSubscribed?.();
    // Reset the attempt count so a subsequent reconnect starts its backoff
    // fresh (a re-subscribe after a long-lived subscription should log/space
    // like a first attempt, not resume the pre-connection tail's cadence).
    attemptCount = 0;
    await hooks.parkForReconnect();
  }
}

/**
 * Attempt one `subscribe()`; returns the unsubscribe closure on success, or
 * `undefined` on failure (logged + counted). Never throws — a failure is a
 * signal to the loop, not a fatal condition (the whole point of this helper).
 */
async function trySubscribeOnce(hooks: LoopHooks, attemptCount: number): Promise<(() => void) | undefined> {
  try {
    return await hooks.deps.listener.subscribe(hooks.deps.channel, hooks.deps.handler);
  } catch (error) {
    hooks.log.info("notify subscribe attempt failed", { channel: hooks.deps.channel, attempt: attemptCount }, error);
    return undefined;
  }
}

/**
 * The default sleep: a plain `setTimeout` for cadence spacing between subscribe
 * retries. This is a legitimate progress-spaced interval (see the doctrine at
 * `scripts/check-architecture-timeouts.mjs` — cadence is BLESSED, kill-verb
 * bodies are not). The callback body just `resolve`s the wait; there is no
 * `reject`/`throw`/`abort`/`destroy`/`fail`/`terminate`/`timedOut` verb, so the
 * `killVerb` lint does not fire and no `arch-allow` annotation is required.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
