import type { SensitivityRule } from "./sensitivity.js";

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

export const queuePolicySensitivityRules: SensitivityRule[] = [
  ...publicRules("merge.policy.revised", ["policyId", "version", "compiledHash"]),
  ...publicRules("merge.queue.command_applied", ["commandId", "command", "idempotencyKey", "result"]),
  ...publicRules("merge.queue.window_changed", ["windowId", "name", "kind", "action"]),
  ...publicRules("merge.queue.admission_held", ["queueId", "reason", "phase"]),
];
