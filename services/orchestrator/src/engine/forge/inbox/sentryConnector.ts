// Sentry source connector.
//
// Reads UNRESOLVED Sentry issues for an org/project through the Sentry Web API
// (`GET /api/0/projects/{org}/{project}/issues/?query=is:unresolved`) and maps
// each to a raw `IngestedItem` the engine persists as a candidate. It is wired
// under the `errors` source kind (the inbox's slot for error-tracking sources)
// so no `SourceKind` enum value — and therefore no DB CHECK migration — is
// added; see the connector factory in engine.ts.
//
// Everything the connector needs to hit Sentry is injected: an auth token is
// read from the SAME secret store the GitHub connector uses (via the config's
// `tokenRef`), and the HTTP transport is an injectable `SentryHttpClient`, so
// tests drive it with a fake (no live token / no network) — see
// candidateInbox.test.ts.

import { z } from "zod";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { IngestedItem, InboxSource, SourceConnector } from "./types.js";

// The `config` shape a Sentry source carries. `org`/`project` are the Sentry
// slugs; `tokenRef` is the secret-store ref for the auth token (a Sentry
// internal-integration / personal auth token). `baseUrl` defaults to Sentry
// SaaS but is overridable for self-hosted. `query` overrides the default issue
// search; `level` (optional) narrows to a single Sentry level.
export const SentryConfig = z
  .object({
    org: z.string().min(1),
    project: z.string().min(1),
    tokenRef: z.string().min(1),
    baseUrl: z.string().url().default("https://sentry.io"),
    query: z.string().min(1).optional(),
    level: z.enum(["debug", "info", "warning", "error", "fatal", "sample"]).optional(),
  })
  .strict();
export type SentryConfig = z.infer<typeof SentryConfig>;

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

function buildPath(config: SentryConfig): string {
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
      const config = SentryConfig.parse(source.config);
      const secret = await deps.secrets.get(config.tokenRef);
      if (secret === undefined) {
        throw new Error(`sentry connector: no secret at ref ${config.tokenRef}`);
      }

      const response = await deps.sentryHttp.request({
        method: "GET",
        path: buildPath(config),
        token: secret.value,
        baseUrl: config.baseUrl,
      });
      if (response.status !== 200 || !Array.isArray(response.body)) {
        return [];
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
