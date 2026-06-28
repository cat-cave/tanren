// task #82 — window-pause auto-resume: sensitivity tags for the three new
// events (run.paused / run.resumed / usage.window.refreshed). Extracted from
// the parent rule modules so the existing 500-line caps hold. Every field is
// a closed-vocab identifier / numeric / ISO timestamp — no secret-adjacent
// content can ride a pause-cycle payload.

import type { SensitivityRule } from "./sensitivity.js";

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}

export const windowPauseSensitivityRules: SensitivityRule[] = [
  ...rulesFor("run.paused", [
    ["provider", "public"],
    ["slot", "public"],
    ["usedPercent", "public"],
    ["resetsAt", "public"],
    ["reason", "public"],
  ]),
  ...rulesFor("run.resumed", [
    ["provider", "public"],
    ["slot", "public"],
    ["usedPercent", "public"],
    ["pausedDurationSeconds", "public"],
  ]),
  ...rulesFor("usage.window.refreshed", [
    ["provider", "public"],
    ["slot", "public"],
    ["usedPercent", "public"],
    ["refreshSource", "public"],
    ["priorUsedPercent", "public"],
    ["priorResetsAt", "public"],
  ]),
];
