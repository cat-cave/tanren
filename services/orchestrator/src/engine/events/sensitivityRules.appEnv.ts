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

// in-17 durable post-merge delivery DAG (release activation) — colocated on this
// deploy/runtime-env activation vocab file so `sensitivityRules.ts` imports it off an
// EXISTING slot (honoring the import-slot ceiling). ALL fields public: references +
// digests only (no token, no secret value, no provider response body).
export const deliveryDagSensitivityRules: SensitivityRule[] = [
  ...rulesFor("delivery.completed", [
    ["deliveryRunId", "public"],
    ["mergeSha", "public"],
    ["deploymentId", "public"],
    ["stagesConfirmed[]", "public"],
    ["observedEffect", "public"],
    ["evidenceDigest", "public"],
    ["signature", "public"],
  ]),
  ...rulesFor("delivery.degraded", [
    ["deliveryRunId", "public"],
    ["stage", "public"],
    ["classification", "public"],
    ["detail", "public"],
  ]),
  ...rulesFor("delivery.demo_stimulus_started", [
    ["deliveryRunId", "public"],
    ["mergeSha", "public"],
  ]),
  ...rulesFor("delivery.demo_stimulus_aborted", [
    ["deliveryRunId", "public"],
    ["reason", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
