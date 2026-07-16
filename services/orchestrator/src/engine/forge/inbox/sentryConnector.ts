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
import type { OrgGrant } from "../../contracts/integrationProvisioner.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { PgIntegrationAuthority } from "../../integrations/integrationAuthorityImpl.js";
import { GenerationAddressedIntegrationSecretStore } from "../../integrations/integrationSecretStoreImpl.js";
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
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  }
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

// A Sentry issue as the Issues API returns it (the fields we map). All optional
// because we validate defensively rather than trusting the upstream shape.
interface RawSentryIssue {
  id?: unknown;
  shortId?: unknown;
  title?: unknown;
  culprit?: unknown;
  level?: unknown;
  permalink?: unknown;
  count?: unknown;
  userCount?: unknown;
  metadata?: { value?: unknown; type?: unknown } | undefined;
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

// The candidate title prefers the issue title, then the human culprit, then the
// metadata value — whichever first carries signal.
function titleFor(issue: RawSentryIssue): string | undefined {
  return asString(issue.title) ?? asString(issue.culprit) ?? asString(issue.metadata?.value) ?? asString(issue.shortId);
}

// The candidate body is the permalink plus the metadata Sentry already
// computed (type/value/level + event/user counts) so the triage answerer and
// the surface have the context without a second round-trip.
function bodyFor(issue: RawSentryIssue): string {
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

      const response = await deps.sentryHttp.request({
        method: "GET",
        path: buildPath(config),
        token,
        baseUrl: config.baseUrl,
      });
      // No-silent-fallbacks: a non-200 is a LOUD throw (401/403 ⇒ auth, else ⇒
      // transient), NEVER an empty list. Only a genuine 200-with-an-array is "no
      // unresolved issues". A 200 whose body is not the expected array is a failed
      // read (shape changed / error envelope) — also LOUD.
      assertIntakeResponseOk("sentry", response.status);
      if (!Array.isArray(response.body)) {
        throw new IntakeSourceFetchError("sentry", response.status, "200 body was not an issues array");
      }

      const issues = response.body as RawSentryIssue[];
      const items: IngestedItem[] = [];
      for (const issue of issues) {
        const id = asString(issue.id);
        const title = titleFor(issue);
        // Skip anything without a stable id or any title signal.
        if (id === undefined || title === undefined) continue;
        items.push({
          // Idempotent external id = the Sentry issue id.
          externalId: `sentry-${id}`,
          title: title.slice(0, 300),
          body: bodyFor(issue),
          severity: severityFromLevel(asString(issue.level)),
          projectId: source.projectId,
        });
      }
      return items;
    },
  };
}
