import type { SensitivityRule } from "./sensitivity.js";
import { auditEnvelopeRulesFor } from "./sensitivityRules.audit.js";

// capability-driven onboarding sensitivity rules, split into their own
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
  // The released artifact's checksum + provenance ref (non-secret) + the audit
  // envelope (policy version + initiating actor) — a deploy is a governing action.
  ...auditEnvelopeRulesFor("deploy.triggered"),

  // deploy.verified ("the deploy is PROVEN live"): the verified deploy target + the
  // resolved live URL + the final READY state + the smoke HTTP status. All non-secret
  // — the deploy token + runtime env values went only into the provider requests.
  { eventName: "deploy.verified", path: "provider", tag: "public" },
  { eventName: "deploy.verified", path: "appId", tag: "public" },
  { eventName: "deploy.verified", path: "deploymentId", tag: "public" },
  { eventName: "deploy.verified", path: "url", tag: "public" },
  { eventName: "deploy.verified", path: "state", tag: "public" },
  { eventName: "deploy.verified", path: "smokeStatus", tag: "public" },
  // The audit envelope on the verify (same governing deploy action), all public.
  ...auditEnvelopeRulesFor("deploy.verified"),

  // deploy.failed: the deploy target + the failure phase + the attempt count + a
  // NON-SECRET reason (the bounded summary). No token/env values.
  { eventName: "deploy.failed", path: "provider", tag: "public" },
  { eventName: "deploy.failed", path: "appId", tag: "public" },
  { eventName: "deploy.failed", path: "phase", tag: "public" },
  { eventName: "deploy.failed", path: "deploymentId", tag: "public" },
  { eventName: "deploy.failed", path: "attempts", tag: "public" },
  { eventName: "deploy.failed", path: "reason", tag: "public" },
  ...auditEnvelopeRulesFor("deploy.failed"),

  // deploy.skipped: a PRE-resolution skip — the project id + a fixed reason code + a
  // bounded non-secret detail string. No token/env values, no provider/appId (the skip
  // is BEFORE a target resolves).
  { eventName: "deploy.skipped", path: "projectId", tag: "public" },
  { eventName: "deploy.skipped", path: "reason", tag: "public" },
  { eventName: "deploy.skipped", path: "detail", tag: "public" },

  // deploy.pending_manual ("a manual_external deploy is awaiting operator confirmation"):
  // the operator-facing wake for an out-of-band deploy. Every field is non-secret (a
  // URL + repo/git-ref + ids + a confirmation route path) — the confirmation itself
  // carries no credential material.
  { eventName: "deploy.pending_manual", path: "provider", tag: "public" },
  { eventName: "deploy.pending_manual", path: "appId", tag: "public" },
  { eventName: "deploy.pending_manual", path: "repo", tag: "public" },
  { eventName: "deploy.pending_manual", path: "ref", tag: "public" },
  { eventName: "deploy.pending_manual", path: "deploymentId", tag: "public" },
  { eventName: "deploy.pending_manual", path: "url", tag: "public" },
  { eventName: "deploy.pending_manual", path: "surfaceKind", tag: "public" },
  { eventName: "deploy.pending_manual", path: "orgId", tag: "public" },
  { eventName: "deploy.pending_manual", path: "projectId", tag: "public" },
  { eventName: "deploy.pending_manual", path: "confirmationPath", tag: "public" },
  ...auditEnvelopeRulesFor("deploy.pending_manual"),

  // deploy.manual_confirmed ("an operator confirmed the manual_external deploy"): the
  // operator's user id is the audit trail. Every field is non-secret (an internal user
  // id + ids).
  { eventName: "deploy.manual_confirmed", path: "provider", tag: "public" },
  { eventName: "deploy.manual_confirmed", path: "appId", tag: "public" },
  { eventName: "deploy.manual_confirmed", path: "deploymentId", tag: "public" },
  { eventName: "deploy.manual_confirmed", path: "orgId", tag: "public" },
  { eventName: "deploy.manual_confirmed", path: "projectId", tag: "public" },
  { eventName: "deploy.manual_confirmed", path: "confirmedBy", tag: "public" },
  ...auditEnvelopeRulesFor("deploy.manual_confirmed"),

  // demos-as-evidence: the per-behavior demo verdict + the summary. Every field is
  // non-secret — a behavior id/title, a surface kind, an outcome, and the OBSERVABLE
  // SHAPE of the reach ("GET /links → HTTP 200"); never a token or a response body.
  { eventName: "demo.evidence.recorded", path: "behaviorId", tag: "public" },
  { eventName: "demo.evidence.recorded", path: "behaviorTitle", tag: "public" },
  { eventName: "demo.evidence.recorded", path: "surfaceKind", tag: "public" },
  { eventName: "demo.evidence.recorded", path: "outcome", tag: "public" },
  { eventName: "demo.evidence.recorded", path: "detail", tag: "public" },
  { eventName: "demo.completed", path: "surfaceKind", tag: "public" },
  { eventName: "demo.completed", path: "behaviorCount", tag: "public" },
  { eventName: "demo.completed", path: "passed", tag: "public" },
  { eventName: "demo.completed", path: "failed", tag: "public" },

  // demo.failed: a durable demo-failure record — a fixed reason code + a bounded
  // non-secret detail summary + the optional provider/surface kind. No token or
  // response body ever reaches here; the full error stays in the run logs.
  { eventName: "demo.failed", path: "reason", tag: "public" },
  { eventName: "demo.failed", path: "detail", tag: "public" },
  { eventName: "demo.failed", path: "provider", tag: "public" },
  { eventName: "demo.failed", path: "surfaceKind", tag: "public" },
];
