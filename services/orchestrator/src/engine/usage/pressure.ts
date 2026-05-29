import type { SubscriptionWindow } from "./contracts.js";

// Default pressure threshold: 100 means "the window is fully consumed". An
// operator can lower it (e.g. 90) to escalate before a window is exhausted.
export const DEFAULT_WINDOW_PRESSURE_THRESHOLD = 100;

// evaluateWindowPressure is a PURE pre-flight check: given the live windows for
// a provider, it returns the single WORST window at/over the threshold, or null
// when every window is below it. "Worst" = highest usedPercent; ties break by
// the soonest reset (the more urgent constraint). The planner loop calls it
// (via SshUsageProbe) before dispatch and escalates window pressure
// (PROJECT_BRIEF §4.3) instead of dispatching a doomed call.
export function evaluateWindowPressure(
  windows: SubscriptionWindow[],
  thresholdPercent: number = DEFAULT_WINDOW_PRESSURE_THRESHOLD,
): SubscriptionWindow | null {
  let worst: SubscriptionWindow | null = null;
  for (const window of windows) {
    if (window.usedPercent < thresholdPercent) {
      continue;
    }
    if (worst === null || isWorse(window, worst)) {
      worst = window;
    }
  }
  return worst;
}

function isWorse(candidate: SubscriptionWindow, current: SubscriptionWindow): boolean {
  if (candidate.usedPercent !== current.usedPercent) {
    return candidate.usedPercent > current.usedPercent;
  }
  // Equal pressure → the sooner-resetting window is the more urgent one.
  return Date.parse(candidate.resetsAt) < Date.parse(current.resetsAt);
}
