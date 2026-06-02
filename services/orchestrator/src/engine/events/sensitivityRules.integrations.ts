import type { SensitivityRule } from "./sensitivity.js";

// P-INT-2 capability-driven onboarding sensitivity rules, split into their own
// module so `sensitivityRules.infra.ts` stays under the 500-line cap. ALL fields
// are public: the `integration.provisioned` payload narrates a provision/bind by
// REFERENCE only — capability/provider/action/mode + the secret-manager ref NAMES
// (NOT values) + the wired surface ids. No raw secret material reaches the payload
// (the provisioning engine never reads a secret value), so nothing here is
// `secret`/`redacted`.
export const integrationProvisioningSensitivityRules: SensitivityRule[] = [
  { eventName: "integration.provisioned", path: "capability", tag: "public" },
  { eventName: "integration.provisioned", path: "providerKind", tag: "public" },
  { eventName: "integration.provisioned", path: "action", tag: "public" },
  { eventName: "integration.provisioned", path: "mode", tag: "public" },
  { eventName: "integration.provisioned", path: "secretRefNames[]", tag: "public" },
  { eventName: "integration.provisioned", path: "surfaces.inboxSourceId", tag: "public" },
  { eventName: "integration.provisioned", path: "surfaces.notificationTargetId", tag: "public" },
  { eventName: "integration.provisioned", path: "surfaces.projectConfigKeys[]", tag: "public" },
  { eventName: "integration.provisioned", path: "surfaces.deployRef", tag: "public" },
];
