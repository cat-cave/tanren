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

  // deploy.triggered ("a deploy happened"): the deploy target + merged source + the
  // resolved live URL + deployment id. Every field is non-secret — the deploy token
  // + runtime env VALUES went only into the provider requests, never this event.
  { eventName: "deploy.triggered", path: "provider", tag: "public" },
  { eventName: "deploy.triggered", path: "appId", tag: "public" },
  { eventName: "deploy.triggered", path: "repo", tag: "public" },
  { eventName: "deploy.triggered", path: "ref", tag: "public" },
  { eventName: "deploy.triggered", path: "deploymentId", tag: "public" },
  { eventName: "deploy.triggered", path: "url", tag: "public" },
  { eventName: "deploy.triggered", path: "state", tag: "public" },

  // deploy.verified ("the deploy is PROVEN live"): the verified deploy target + the
  // resolved live URL + the final READY state + the smoke HTTP status. All non-secret
  // — the deploy token + runtime env values went only into the provider requests.
  { eventName: "deploy.verified", path: "provider", tag: "public" },
  { eventName: "deploy.verified", path: "appId", tag: "public" },
  { eventName: "deploy.verified", path: "deploymentId", tag: "public" },
  { eventName: "deploy.verified", path: "url", tag: "public" },
  { eventName: "deploy.verified", path: "state", tag: "public" },
  { eventName: "deploy.verified", path: "smokeStatus", tag: "public" },
];
