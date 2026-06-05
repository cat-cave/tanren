import type { SensitivityRule } from "./sensitivity.js";

// Plane B app-environment sensitivity rules, split out of sensitivityRules.ts to
// keep each file under the 500-line cap. The event carries ONLY non-secret
// descriptors (the deploy target + the env-var KEY NAMES) — never a secret VALUE;
// the values went only into the provider's deploy set-env request. Every field is
// `public`.
export const appEnvSensitivityRules: SensitivityRule[] = [
  // app_env.runtime_attached: deploy target + env KEY NAMES.
  ...rulesFor("app_env.runtime_attached", [
    ["provider", "public"],
    ["appId", "public"],
    ["keys[]", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
