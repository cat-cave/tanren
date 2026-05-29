// Jira source connector.
//
// Reads issues from a Jira project through the Jira Cloud REST API
// (`POST https://<site>/rest/api/3/search`, HTTP Basic auth with an account
// email + API token) and maps each to a raw `IngestedItem` the engine persists
// as a candidate. Jira is an issue tracker, so it is wired under the EXISTING
// `issues` source kind — no `SourceKind` enum value and therefore no DB CHECK
// migration is added (the same move the Linear/Sentry connectors made). See the
// `issues` dispatcher in issuesConnector.ts and the factory in
// routes/inbox/index.ts.
//
// Everything the connector needs to hit Jira is injected: the API token is read
// from the SAME secret store the GitHub/Linear/Sentry connectors use (via the
// config's `tokenRef`), and the HTTP transport is an injectable
// `JiraHttpClient`, so tests drive it with a fake (no live creds / no network)
// — see candidateInboxJira.test.ts.

import { z } from "zod";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { IngestedItem, InboxSource, SourceConnector } from "./types.js";

// The `config` shape a Jira `issues` source carries. `provider: "jira"` selects
// this connector in the `issues` dispatcher. `baseUrl` is the Jira site
// (`https://your-domain.atlassian.net`); `email` + `tokenRef` form the Basic
// auth pair (the API token is read from the secret store). The query is built
// from either an explicit `jql` or a `project`/`status` filter; `jql` wins when
// present. `provider` is optional here (the dispatcher already keyed on it) but
// accepted so the schema round-trips a full config.
export const JiraConfig = z
  .object({
    provider: z.literal("jira").optional(),
    baseUrl: z.string().url(),
    email: z.string().min(1),
    tokenRef: z.string().min(1),
    jql: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
  })
  .strict();
export type JiraConfig = z.infer<typeof JiraConfig>;

// The injectable Jira transport. A search request carries the resolved Basic
// auth header value, the search endpoint URL, and the JSON body. Mirrors the
// shape of the Linear/Sentry clients so the same test pattern (a fake returning
// `{ status, body }`) applies.
export interface JiraHttpRequest {
  url: string;
  authorization: string;
  body: Record<string, unknown>;
}

export interface JiraHttpResponse {
  status: number;
  body: unknown;
}

export interface JiraHttpClient {
  request(input: JiraHttpRequest): Promise<JiraHttpResponse>;
}

// The production transport: a thin fetch wrapper that POSTs the JQL search with
// the Basic auth header. Injectable `fetchImpl` keeps it testable, but tests of
// the connector itself inject a fake directly.
export class FetchJiraHttpClient implements JiraHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async request(input: JiraHttpRequest): Promise<JiraHttpResponse> {
    const response = await this.fetchImpl(input.url, {
      method: "POST",
      headers: {
        Authorization: input.authorization,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input.body),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  }
}

export interface JiraConnectorDeps {
  secrets: SecretStore;
  jiraHttp: JiraHttpClient;
}

// A Jira issue as the search API returns it (the fields we map). All optional
// because we validate defensively rather than trusting the upstream shape.
interface RawJiraPriority {
  name?: unknown;
}

interface RawJiraFields {
  summary?: unknown;
  description?: unknown;
  priority?: RawJiraPriority | null;
}

interface RawJiraIssue {
  key?: unknown;
  fields?: RawJiraFields | undefined;
}

interface SearchResponse {
  issues?: RawJiraIssue[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Jira descriptions in API v3 are Atlassian Document Format (ADF) — a nested
// node tree — or, on older/simpler configs, a plain string. Flatten the ADF
// `text` leaves to a readable string; pass plain strings through.
function flattenDescription(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (value === null || typeof value !== "object") return undefined;
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const text = record["text"];
    if (typeof text === "string" && text.length > 0) parts.push(text);
    walk(record["content"]);
  };
  walk((value as Record<string, unknown>)["content"]);
  const joined = parts.join(" ").trim();
  return joined.length > 0 ? joined : undefined;
}

// Map a Jira issue to inbox severity. Jira's default priority names are the
// primary signal — Highest/High → fail, Medium → warn, else → info. Mirrors the
// escalation feel of the GitHub/Linear connectors.
function severityFor(fields: RawJiraFields): IngestedItem["severity"] {
  const priority = asString(fields.priority?.name)?.toLowerCase() ?? "";
  if (priority.includes("highest") || priority.includes("critical") || priority.includes("blocker")) {
    return "fail";
  }
  if (priority === "high") return "fail";
  if (priority.includes("medium")) return "warn";
  return "info";
}

// The candidate body is the (flattened) description plus the Jira issue URL so
// the triage answerer and the surface have the issue context + a deep link
// without a second round-trip.
function bodyFor(fields: RawJiraFields, url: string): string {
  const lines: string[] = [];
  const description = flattenDescription(fields.description);
  if (description !== undefined) lines.push(description);
  lines.push(url);
  return lines.join("\n\n").slice(0, 8000);
}

// Build the JQL the search runs: an explicit `jql` wins; otherwise compose from
// the optional `project`/`status` filter, ordered newest-first.
function buildJql(config: JiraConfig): string {
  if (config.jql !== undefined) return config.jql;
  const clauses: string[] = [];
  if (config.project !== undefined) clauses.push(`project = "${config.project}"`);
  if (config.status !== undefined) clauses.push(`status = "${config.status}"`);
  const where = clauses.length > 0 ? `${clauses.join(" AND ")} ` : "";
  return `${where}ORDER BY updated DESC`;
}

// HTTP Basic auth header from the account email + API token, base64-encoded.
function basicAuth(email: string, token: string): string {
  const encoded = Buffer.from(`${email}:${token}`).toString("base64");
  return `Basic ${encoded}`;
}

export function createJiraConnector(deps: JiraConnectorDeps): SourceConnector {
  return {
    // Wired under the existing `issues` slot — Jira is an issue tracker. This
    // reuses the enum value (no migration); the `issues` dispatcher routes to
    // this connector when `config.provider === "jira"`.
    kind: "issues",
    async fetch(source: InboxSource): Promise<IngestedItem[]> {
      const config = JiraConfig.parse(source.config);
      const secret = await deps.secrets.get(config.tokenRef);
      if (secret === undefined) {
        throw new Error(`jira connector: no secret at ref ${config.tokenRef}`);
      }

      const baseUrl = config.baseUrl.replace(/\/+$/, "");
      const response = await deps.jiraHttp.request({
        url: `${baseUrl}/rest/api/3/search`,
        authorization: basicAuth(config.email, secret.value),
        body: {
          jql: buildJql(config),
          maxResults: 50,
          fields: ["summary", "description", "priority"],
        },
      });
      if (response.status !== 200) return [];

      const issues = (response.body as SearchResponse).issues;
      if (!Array.isArray(issues)) return [];

      const items: IngestedItem[] = [];
      for (const issue of issues) {
        const key = asString(issue.key);
        const fields = issue.fields ?? {};
        const title = asString(fields.summary);
        // Skip anything without a stable key or a title.
        if (key === undefined || title === undefined) continue;
        const url = `${baseUrl}/browse/${key}`;
        items.push({
          // Idempotent external id = the Jira issue key.
          externalId: `jira-${key}`,
          title: title.slice(0, 300),
          body: bodyFor(fields, url),
          severity: severityFor(fields),
          projectId: source.projectId,
        });
      }
      return items;
    },
  };
}
