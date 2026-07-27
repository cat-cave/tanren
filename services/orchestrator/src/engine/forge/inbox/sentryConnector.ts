// Sentry source connector.
//
// Reads UNRESOLVED Sentry issues for an org/project through the Sentry Web API
// (`GET /api/0/projects/{org}/{project}/issues/?query=is:unresolved`) and maps
// each to a raw `IngestedItem` the engine persists as a candidate. It is wired
// under the `errors` source kind (the inbox's slot for error-tracking sources)
// so no `SourceKind` enum value — and therefore no DB CHECK migration — is
// added; see the connector factory in engine.ts.
//
// Each fetch obtains exact `intake` authority from the persisted project
// selection, resolves that lease's generation-addressed secret, and only then
// calls the injectable HTTP transport. Reusable credential coordinates never
// enter source config.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type { OrgGrant } from "../../contracts/integrationProvisioner.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { PgIntegrationAuthority } from "../../integrations/integrationAuthorityImpl.js";
import { GenerationAddressedIntegrationSecretStore } from "../../integrations/integrationSecretStoreImpl.js";
import { sentryNextPage, SentryPaginationError } from "../../integrations/sentryPagination.js";
import { canonicalSentryEndpoint, requireSentryPrincipalIdentity } from "../../integrations/sentryPrincipalIdentity.js";
import { IntegrationConnectionsStore } from "../../repositories/integrationConnections.js";
import { assertOrgGrantMatchesLease, secretValueForLease } from "../../repositories/integrationConnectionResolve.js";
import { systemActor } from "../../state/actor.js";
import { assertIntakeResponseOk, IntakeSourceAuthorityError, IntakeSourceFetchError } from "./connectorErrors.js";
import { ActiveSentryConfig, type IngestedItem, type InboxSource, type SourceConnector } from "./types.js";

// The injectable Sentry transport. A `path` is org/project-scoped; `token` is
// the resolved auth token. Mirrors the shape of `GitHubHttpClient` so the same
// test pattern (a fake returning `{ status, body }`) applies.
export interface SentryHttpRequest {
  method: "GET";
  path: string;
  token: string;
  baseUrl: string;
}

export interface SentryHttpResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string | undefined>>;
}

export interface SentryHttpClient {
  request(input: SentryHttpRequest): Promise<SentryHttpResponse>;
}

// The production transport: a thin fetch wrapper that sends the Sentry auth
// token as a Bearer header. Injectable `fetchImpl` keeps it testable, but tests
// of the connector itself inject a fake `SentryHttpClient` directly.
export class FetchSentryHttpClient implements SentryHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async request(input: SentryHttpRequest): Promise<SentryHttpResponse> {
    const response = await this.fetchImpl(`${input.baseUrl.replace(/\/$/u, "")}${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/json",
      },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    return {
      status: response.status,
      body,
      headers: {
        link: response.headers.get("link") ?? undefined,
        "retry-after": response.headers.get("retry-after") ?? undefined,
      },
    };
  }
}

function retryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const deadline = Date.parse(value);
  return Number.isNaN(deadline) ? undefined : Math.max(0, deadline - now);
}

export interface SentryConnectorDeps {
  secrets: SecretStore;
  sentryHttp: SentryHttpClient;
  authority: SentryIntakeAuthority;
}

export type SentryIntakeAuthority = (input: {
  orgId: string;
  projectId: string;
  resourceId: string;
}) => Promise<OrgGrant>;

/** Build the production intake authority over the current project selection. */
export function buildPgSentryIntakeAuthority(pool: pg.Pool): SentryIntakeAuthority {
  return async (input) =>
    runWithSystemScope(pool, async (client) => {
      const result = await new PgIntegrationAuthority().authorizeOperation(client, {
        orgId: input.orgId,
        projectId: input.projectId,
        providerKind: "sentry",
        capability: "errors",
        operation: "intake",
        target: { resourceId: input.resourceId },
        actor: systemActor,
      });
      if (result.status !== "eligible") {
        const reason =
          result.status === "ineligible"
            ? result.reasons.join(",")
            : result.status === "selection_required"
              ? result.reason
              : "not_linked";
        throw new IntakeSourceAuthorityError("sentry", reason);
      }
      return IntegrationConnectionsStore.orgGrantFromLease(result.lease);
    });
}

const SentryIssuePayload = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  project: z.object({ slug: z.string().trim().min(1) }).passthrough(),
  culprit: z.string().min(1).optional(),
  level: z.string().min(1).optional(),
  permalink: z.string().min(1).optional(),
  count: z.union([z.string(), z.number()]).optional(),
  userCount: z.union([z.string(), z.number()]).optional(),
  metadata: z.object({ value: z.string().min(1).optional(), type: z.string().min(1).optional() }).optional(),
});
type SentryIssuePayload = z.infer<typeof SentryIssuePayload>;
function fetchError(detail: string): never {
  throw new IntakeSourceFetchError("sentry", 200, detail);
}

// Map a Sentry `level` to the inbox severity. fatal/error → fail (a live
// production error), warning → warn, everything else (info/debug/sample) → info.
function severityFromLevel(level: string | undefined): IngestedItem["severity"] {
  switch ((level ?? "").toLowerCase()) {
    case "fatal":
    case "error":
      return "fail";
    case "warning":
      return "warn";
    default:
      return "info";
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// The candidate body is the permalink plus the metadata Sentry already
// computed (type/value/level + event/user counts) so the triage answerer and
// the surface have the context without a second round-trip.
function bodyFor(issue: SentryIssuePayload): string {
  const lines: string[] = [];
  const permalink = asString(issue.permalink);
  if (permalink !== undefined) lines.push(permalink);
  const culprit = asString(issue.culprit);
  if (culprit !== undefined) lines.push(`culprit: ${culprit}`);
  const type = asString(issue.metadata?.type);
  const value = asString(issue.metadata?.value);
  if (type !== undefined || value !== undefined) {
    lines.push(`${type ?? "error"}: ${value ?? ""}`.trim());
  }
  const level = asString(issue.level);
  if (level !== undefined) lines.push(`level: ${level}`);
  if (typeof issue.count === "number" || typeof issue.count === "string") {
    lines.push(`events: ${issue.count}`);
  }
  if (typeof issue.userCount === "number" || typeof issue.userCount === "string") {
    lines.push(`users affected: ${issue.userCount}`);
  }
  return lines.join("\n").slice(0, 8000);
}

function buildPath(config: ActiveSentryConfig): string {
  const query = config.query ?? "is:unresolved";
  const levelClause = config.level === undefined ? "" : ` level:${config.level}`;
  const search = new URLSearchParams({ query: `${query}${levelClause}`, statsPeriod: "14d" });
  return (
    `/api/0/projects/${encodeURIComponent(config.org)}/${encodeURIComponent(config.project)}` +
    `/issues/?${search.toString()}`
  );
}
function assertSentryAuthorityBinding(grant: OrgGrant, config: ActiveSentryConfig): string {
  const lease = grant.eligibleOperation;
  if (
    grant.providerKind !== "sentry" ||
    lease.capability !== "errors" ||
    lease.operation !== "intake" ||
    lease.target.resourceId !== config.project
  )
    throw new IntakeSourceAuthorityError("sentry", "the selected lease does not bind this project intake effect");
  let identity;
  try {
    identity = requireSentryPrincipalIdentity(grant.metadata);
  } catch {
    throw new IntakeSourceAuthorityError("sentry", "the selected principal has no verified Sentry identity");
  }
  if (identity.orgSlug !== config.org)
    throw new IntakeSourceAuthorityError("sentry", "the source organization does not match the selected principal");
  let sourceBaseUrl: string;
  try {
    sourceBaseUrl = canonicalSentryEndpoint(config.baseUrl);
  } catch {
    throw new IntakeSourceAuthorityError("sentry", "the source endpoint is not a canonical HTTPS endpoint");
  }
  if (sourceBaseUrl !== identity.baseUrl)
    throw new IntakeSourceAuthorityError("sentry", "the source endpoint does not match the selected principal");
  return identity.baseUrl;
}

export function createSentryConnector(deps: SentryConnectorDeps): SourceConnector {
  return {
    // Wired under the `errors` slot — Sentry is an error-tracking source. This
    // reuses the existing enum value (no migration); see the factory.
    kind: "errors",
    async fetch(source: InboxSource): Promise<IngestedItem[]> {
      const config = ActiveSentryConfig.parse(source.config);
      if (source.projectId === null) throw new Error("sentry connector: intake source must name a project");
      const grant = await deps.authority({
        orgId: source.orgId,
        projectId: source.projectId,
        resourceId: config.project,
      });
      assertOrgGrantMatchesLease(grant);
      const baseUrl = assertSentryAuthorityBinding(grant, config);
      const token = await secretValueForLease(
        new GenerationAddressedIntegrationSecretStore(deps.secrets),
        grant.eligibleOperation,
        {
          orgId: source.orgId,
          projectId: source.projectId,
          providerKind: "sentry",
          capability: "errors",
          operation: "intake",
          target: { resourceId: config.project },
        },
      );

      const issuesPath = buildPath(config);
      const issues: SentryIssuePayload[] = [];
      const seenIssueIds = new Set<string>();
      const seenCursors = new Set<string>();
      let initialCursor: string | undefined;
      let currentCursor: string | undefined;
      let path: string | undefined = issuesPath;
      while (path !== undefined) {
        const response = await deps.sentryHttp.request({ method: "GET", path, token, baseUrl });
        assertIntakeResponseOk(
          "sentry",
          response.status,
          "provider response",
          retryAfterMs(response.headers?.["retry-after"]),
        );
        if (!Array.isArray(response.body)) fetchError("200 body was not an issues array");
        const page = z.array(SentryIssuePayload).parse(response.body);
        for (const issue of page) {
          if (issue.project.slug !== config.project) fetchError("issue project did not match the configured project");
          if (seenIssueIds.has(issue.id)) fetchError("provider repeated an issue id");
          seenIssueIds.add(issue.id);
          issues.push(issue);
        }
        let next;
        try {
          next = sentryNextPage({
            link: response.headers?.["link"],
            baseUrl,
            resourcePath: issuesPath,
            initialCursor,
            currentCursor,
            seenCursors,
          });
        } catch (error) {
          if (error instanceof SentryPaginationError) fetchError(error.message);
          throw error;
        }
        if (next === null) path = undefined;
        else {
          seenCursors.add(next.cursor);
          initialCursor = next.initialCursor;
          currentCursor = next.cursor;
          path = next.path;
        }
      }

      return issues.map(
        (issue): IngestedItem => ({
          // Idempotent external id = the Sentry issue id.
          externalId: `sentry-${issue.id}`,
          title: issue.title.slice(0, 300),
          body: bodyFor(issue),
          severity: severityFromLevel(asString(issue.level)),
          projectId: source.projectId,
        }),
      );
    },
  };
}
