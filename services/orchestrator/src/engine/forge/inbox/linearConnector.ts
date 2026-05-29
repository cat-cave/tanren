// Linear source connector.
//
// Reads OPEN Linear issues for a team/project through the Linear GraphQL API
// (`POST https://api.linear.app/graphql`, `Authorization: <token>`) and maps
// each to a raw `IngestedItem` the engine persists as a candidate. Linear is an
// issue tracker, so it is wired under the EXISTING `issues` source kind — no
// `SourceKind` enum value and therefore no DB CHECK migration is added (the
// same move the Sentry connector made under `errors`). See the `issues`
// dispatcher in issuesConnector.ts and the factory in routes/inbox/index.ts.
//
// Everything the connector needs to hit Linear is injected: an auth token is
// read from the SAME secret store the GitHub/Sentry connectors use (via the
// config's `tokenRef`), and the HTTP transport is an injectable
// `LinearHttpClient`, so tests drive it with a fake (no live token / no
// network) — see candidateInbox.test.ts.

import { z } from "zod";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { IngestedItem, InboxSource, SourceConnector } from "./types.js";

// The `config` shape a Linear `issues` source carries. `provider: "linear"`
// selects this connector in the `issues` dispatcher. `tokenRef` is the
// secret-store ref for a Linear API token (a personal API key or OAuth token).
// `teamId`/`projectId` scope the query; `states`/`labels` (optional) narrow to
// named workflow states / labels. `endpoint` defaults to Linear SaaS but is
// overridable. `provider` is optional here (the dispatcher already keyed on it)
// but accepted so the schema round-trips a full source config.
export const LinearConfig = z
  .object({
    provider: z.literal("linear").optional(),
    tokenRef: z.string().min(1),
    teamId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    states: z.array(z.string().min(1)).default([]),
    labels: z.array(z.string().min(1)).default([]),
    endpoint: z.string().url().default("https://api.linear.app/graphql"),
  })
  .strict();
export type LinearConfig = z.infer<typeof LinearConfig>;

// The injectable Linear transport. A GraphQL request carries the resolved auth
// token, the query, and its variables. Mirrors the shape of the Sentry/GitHub
// clients so the same test pattern (a fake returning `{ status, body }`)
// applies.
export interface LinearHttpRequest {
  endpoint: string;
  token: string;
  query: string;
  variables: Record<string, unknown>;
}

export interface LinearHttpResponse {
  status: number;
  body: unknown;
}

export interface LinearHttpClient {
  request(input: LinearHttpRequest): Promise<LinearHttpResponse>;
}

// The production transport: a thin fetch wrapper that POSTs the GraphQL query
// with the Linear token in the `Authorization` header (Linear personal API keys
// are sent raw, without a `Bearer` prefix). Injectable `fetchImpl` keeps it
// testable, but tests of the connector itself inject a fake directly.
export class FetchLinearHttpClient implements LinearHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async request(input: LinearHttpRequest): Promise<LinearHttpResponse> {
    const response = await this.fetchImpl(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: input.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  }
}

export interface LinearConnectorDeps {
  secrets: SecretStore;
  linearHttp: LinearHttpClient;
}

// A Linear issue as the GraphQL query returns it (the fields we map). All
// optional because we validate defensively rather than trusting the upstream
// shape.
interface RawLinearLabel {
  name?: unknown;
}

interface RawLinearIssue {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  priority?: unknown;
  labels?: { nodes?: RawLinearLabel[] } | undefined;
}

// The GraphQL query: open issues (workflow state type not "completed"/
// "canceled") for an optional team/project, newest first. The connector filters
// labels client-side from the config so the query stays simple.
const ISSUES_QUERY = `query InboxIssues($filter: IssueFilter, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      description
      url
      priority
      labels { nodes { name } }
    }
  }
}`;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function labelNames(issue: RawLinearIssue): string[] {
  const nodes = issue.labels?.nodes ?? [];
  return nodes.map((l) => asString(l.name)).filter((l): l is string => l !== undefined);
}

// Map a Linear issue to inbox severity. Priority is the primary signal —
// Linear's 1 = Urgent, 2 = High, 3 = Medium, 4 = Low, 0 = No priority. Urgent →
// fail; High → warn. A bug-style label escalates to fail regardless of
// priority (mirrors the GitHub connector's label heuristic).
function severityFor(issue: RawLinearIssue): IngestedItem["severity"] {
  const labels = labelNames(issue).map((l) => l.toLowerCase());
  if (labels.some((l) => l.includes("bug") || l.includes("regression") || l.includes("critical"))) {
    return "fail";
  }
  const priority = typeof issue.priority === "number" ? issue.priority : 0;
  if (priority === 1) return "fail";
  if (priority === 2) return "warn";
  if (labels.some((l) => l.includes("warn") || l.includes("perf"))) return "warn";
  return "info";
}

// The candidate body is the description plus the Linear URL so the triage
// answerer and the surface have the issue context + a deep link without a
// second round-trip.
function bodyFor(issue: RawLinearIssue): string {
  const lines: string[] = [];
  const description = asString(issue.description);
  if (description !== undefined) lines.push(description);
  const url = asString(issue.url);
  if (url !== undefined) lines.push(url);
  return lines.join("\n\n").slice(0, 8000);
}

// Build the GraphQL `IssueFilter` from the config: open issues (state type not
// completed/canceled), optionally scoped to a team/project.
function buildFilter(config: LinearConfig): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    state: { type: { nin: ["completed", "canceled"] } },
  };
  if (config.teamId !== undefined) filter["team"] = { id: { eq: config.teamId } };
  if (config.projectId !== undefined) filter["project"] = { id: { eq: config.projectId } };
  return filter;
}

// Keep only issues matching the optional label config filter.
function matchesFilters(issue: RawLinearIssue, config: LinearConfig): boolean {
  if (config.labels.length === 0) return true;
  const labels = new Set(labelNames(issue).map((l) => l.toLowerCase()));
  return config.labels.some((l) => labels.has(l.toLowerCase()));
}

interface IssuesResponse {
  data?: { issues?: { nodes?: RawLinearIssue[] } };
}

export function createLinearConnector(deps: LinearConnectorDeps): SourceConnector {
  return {
    // Wired under the existing `issues` slot — Linear is an issue tracker. This
    // reuses the enum value (no migration); the `issues` dispatcher routes to
    // this connector when `config.provider === "linear"`.
    kind: "issues",
    async fetch(source: InboxSource): Promise<IngestedItem[]> {
      const config = LinearConfig.parse(source.config);
      const secret = await deps.secrets.get(config.tokenRef);
      if (secret === undefined) {
        throw new Error(`linear connector: no secret at ref ${config.tokenRef}`);
      }

      const response = await deps.linearHttp.request({
        endpoint: config.endpoint,
        token: secret.value,
        query: ISSUES_QUERY,
        variables: { filter: buildFilter(config), first: 50 },
      });
      if (response.status !== 200) return [];

      const nodes = (response.body as IssuesResponse).data?.issues?.nodes;
      if (!Array.isArray(nodes)) return [];

      const items: IngestedItem[] = [];
      for (const issue of nodes) {
        const id = asString(issue.id);
        const title = asString(issue.title);
        // Skip anything without a stable id or a title.
        if (id === undefined || title === undefined) continue;
        if (!matchesFilters(issue, config)) continue;
        items.push({
          // Idempotent external id = the Linear issue id.
          externalId: `linear-${id}`,
          title: title.slice(0, 300),
          body: bodyFor(issue),
          severity: severityFor(issue),
          projectId: source.projectId,
        });
      }
      return items;
    },
  };
}
