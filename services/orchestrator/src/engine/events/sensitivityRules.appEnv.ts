import type { SensitivityRule } from "./sensitivity.js";

// Plane B app-environment (P-APP-ENV) sensitivity rules, split out of
// sensitivityRules.ts to keep each file under the 500-line cap. Both events carry
// ONLY non-secret descriptors (the target + the env-var KEY NAMES) — never a
// secret VALUE; the values went only into the provider write (the deploy set-env
// request / the encrypted Actions-secret PUT). So every field is `public`.
export const appEnvSensitivityRules: SensitivityRule[] = [
  // app_env.runtime_attached (P-APP-ENV-2): deploy target + env KEY NAMES.
  ...rulesFor("app_env.runtime_attached", [
    ["provider", "public"],
    ["appId", "public"],
    ["keys[]", "public"],
  ]),

  // app_env.ci_propagated (P-APP-ENV-1): the target repo + Actions-secret KEY NAMES.
  ...rulesFor("app_env.ci_propagated", [
    ["projectId", "public"],
    ["repo.owner", "public"],
    ["repo.name", "public"],
    ["secretNames[]", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
