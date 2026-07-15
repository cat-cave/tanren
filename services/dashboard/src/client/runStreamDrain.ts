/**
 * Terminal stream phase + idle-grace closer for the run-stream island.
 *
 * live → draining (terminal status) → closed (idle after cost quiet).
 * Drain arms on terminal entry; re-arms only on newly applied cost activity.
 * Stream errors never re-arm. dispose is terminal (generation-fenced timers).
 */

/** Idle window after terminal entry or last newly-applied cost before close. */
export const COST_DRAIN_IDLE_MS = 2_500;

export type RunStreamPhase = "live" | "draining" | "closed";

export function isTerminalRunStatus(status: string): boolean {
  return ["completed", "failed", "halted", "cancelled", "done"].includes(status);
}

export function isFinalStreamState(root: HTMLElement): boolean {
  const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
  return flag?.textContent === "● final";
}

export function getRunStreamPhase(root: HTMLElement): RunStreamPhase {
  const phase = root.dataset["rdPhase"];
  if (phase === "draining" || phase === "closed") return phase;
  return isFinalStreamState(root) ? "draining" : "live";
}

export function setRunStreamPhase(root: HTMLElement, phase: RunStreamPhase): void {
  root.dataset["rdPhase"] = phase;
}

/** Live-flag transitions. Once final, live/stale/unavailable are no-ops. */
export function setStreamState(
  root: HTMLElement,
  state: "live" | "stale" | "unavailable" | "final",
  reason?: string,
): void {
  const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
  if (flag === null) return;
  if (isFinalStreamState(root) && state !== "final") return;
  if (state === "final") {
    flag.textContent = "● final";
    flag.removeAttribute("title");
    if (getRunStreamPhase(root) !== "closed") setRunStreamPhase(root, "draining");
    return;
  }
  if (state === "live") {
    flag.textContent = "↻ live";
    flag.removeAttribute("title");
    return;
  }
  flag.textContent = state === "stale" ? "⚠ stream stale" : "⚠ stream unavailable";
  if (reason !== undefined) flag.title = reason;
}

export function markStreamUnavailableUnlessFinal(root: HTMLElement, reason: string): void {
  if (isFinalStreamState(root) || getRunStreamPhase(root) !== "live") return;
  setStreamState(root, "unavailable", reason);
}

export interface CostDrainCloser {
  enterDrain: (close: () => void) => void;
  noteCostActivity: () => void;
  onStreamError: () => void;
  isDraining: () => boolean;
  isClosed: () => boolean;
  generation: () => number;
  dispose: () => void;
}

/**
 * Idle-grace closer after terminal:
 * - enterDrain arms once (idempotent while draining — no extend)
 * - noteCostActivity re-arms only for newly applied costs
 * - onStreamError never re-arms
 * - dispose is terminal; timer callbacks are generation-fenced
 */
export function createCostDrainCloser(
  opts: {
    idleMs?: number;
    schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    cancel?: (id: ReturnType<typeof setTimeout>) => void;
  } = {},
): CostDrainCloser {
  const idleMs = opts.idleMs ?? COST_DRAIN_IDLE_MS;
  const schedule = opts.schedule ?? setTimeout;
  const cancel = opts.cancel ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeFn: (() => void) | undefined;
  let draining = false;
  let closed = false;
  let gen = 0;

  const arm = (): void => {
    if (!draining || closed || closeFn === undefined) return;
    if (timer !== undefined) cancel(timer);
    const myGen = ++gen;
    timer = schedule(() => {
      if (myGen !== gen || closed) return;
      closed = true;
      draining = false;
      timer = undefined;
      const fn = closeFn;
      closeFn = undefined;
      fn?.();
    }, idleMs);
  };

  return {
    enterDrain(close) {
      if (closed) return;
      if (draining) {
        if (closeFn === undefined) closeFn = close;
        return;
      }
      draining = true;
      closeFn = close;
      arm();
    },
    noteCostActivity() {
      if (!draining || closed) return;
      arm();
    },
    onStreamError() {
      // Post-terminal error: never close now, never re-arm.
    },
    isDraining: () => draining && !closed,
    isClosed: () => closed,
    generation: () => gen,
    dispose() {
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      gen += 1;
      closed = true;
      draining = false;
      closeFn = undefined;
    },
  };
}
