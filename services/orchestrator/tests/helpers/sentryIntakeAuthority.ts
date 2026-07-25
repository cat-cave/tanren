import type { SentryIntakeAuthority } from "../../src/engine/forge/inbox/sentryConnector.js";
import { sentryPrincipalIdentity } from "../../src/engine/integrations/sentryPrincipalIdentity.js";
import { testOrgGrant } from "./orgGrant.js";

/** Authentic exact Sentry intake authority for connector tests. */
export function testSentryIntakeAuthority(
  credentialRef: string,
  identity: { orgSlug: string; baseUrl: string },
): SentryIntakeAuthority {
  return ({ orgId, projectId, resourceId }) =>
    testOrgGrant({
      orgId,
      projectId,
      providerKind: "sentry",
      credentialRef,
      capability: "errors",
      operation: "intake",
      target: { resourceId },
      metadata: sentryPrincipalIdentity(identity.orgSlug, identity.baseUrl),
    });
}
export function terminalSentryLink(input: { baseUrl: string; path: string }): string {
  const target = `${input.baseUrl.replace(/\/$/u, "")}${input.path}${input.path.includes("?") ? "&" : "?"}cursor=0:0:0`;
  return `<${target}>; rel="previous"; results="false"; cursor="0:0:0", <${target}>; rel="next"; results="false"; cursor="0:0:0"`;
}
export function sentryOrganizationsResponse(
  body: unknown,
  baseUrl = "https://sentry.io",
  cursor = "0:0:0",
  results = false,
): Response {
  const path = "/api/0/organizations/?per_page=100";
  const target = `${baseUrl}${path}&cursor=${cursor}`;
  const previous = results ? "0:0:0" : cursor;
  const link =
    `<${baseUrl}${path}&cursor=${previous}>; rel="previous"; results="false"; cursor="${previous}", ` +
    `<${target}>; rel="next"; results="${String(results)}"; cursor="${cursor}"`;
  return Response.json(body, { headers: { link } });
}
