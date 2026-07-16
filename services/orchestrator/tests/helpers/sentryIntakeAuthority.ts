import type { SentryIntakeAuthority } from "../../src/engine/forge/inbox/sentryConnector.js";
import { testOrgGrant } from "./orgGrant.js";

/** Authentic exact Sentry intake authority for connector tests. */
export function testSentryIntakeAuthority(credentialRef: string): SentryIntakeAuthority {
  return ({ orgId, projectId, resourceId }) =>
    testOrgGrant({
      orgId,
      projectId,
      providerKind: "sentry",
      credentialRef,
      capability: "errors",
      operation: "intake",
      target: { resourceId },
    });
}
