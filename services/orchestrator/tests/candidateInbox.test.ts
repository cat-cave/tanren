import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest } from "../src/engine/providers/github.js";
import {
  acceptCandidate,
  createGitHubIssuesConnector,
  createSentryConnector,
  dismissCandidate,
  ingestSource,
  type InboxEngineDeps,
  type InboxSource,
  type SentryHttpClient,
  type SentryHttpRequest,
  type SourceConnector,
  type TriageAnswererContext,
} from "../src/engine/forge/inbox/index.js";
import { mapGithubIssueWebhook } from "../src/engine/forge/intake/index.js";
import { createDeterministicTriageAnswerer } from "./fixtures/forge/deterministicTriageAnswerer.js";
import { terminalSentryLink, testSentryIntakeAuthority } from "./helpers/sentryIntakeAuthority.js";
const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: "project_a",
  scopes: ["platform:admin"],
  source: "session",
};
const issuesSource: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "issues labeled spec-candidate",
  config: {
    owner: "Cat-Cave",
    repo: "App",
    labels: ["spec-candidate"],
  },
  enabled: true,
  autoRoute: false,
};
const auditSource: InboxSource = {
  ...issuesSource,
  id: "src_audit",
  kind: "scheduled_audit",
  name: "scheduled audits",
  config: {},
  autoRoute: true,
};
const sentrySource: InboxSource = {
  id: "src_sentry",
  orgId: "org_a",
  projectId: "project_a",
  kind: "errors",
  name: "sentry · cat-cave/app",
  detail: "unresolved issues",
  config: { org: "cat-cave", project: "app", baseUrl: "https://sentry.io" },
  enabled: true,
  autoRoute: false,
};
const secrets = new InMemorySecretStore();
await secrets.put({ ref: "credential/github/org/org_a/default", value: "ghs_token" });
await secrets.put({ ref: "credential/sentry/x/g/1", value: "sntrys_token" });
const sentryAuthority = testSentryIntakeAuthority("credential/sentry/x/g/1", {
  orgSlug: "cat-cave",
  baseUrl: "https://sentry.io",
});

const sentryConnector = (sentryHttp: SentryHttpClient) =>
  createSentryConnector({ secrets, sentryHttp, authority: sentryAuthority });
const githubConnector = (githubHttp: GitHubHttpClient) =>
  createGitHubIssuesConnector({
    secrets,
    githubHttp,
    defaultStaticRef: "credential/github/org/org_a/default",
  });

function fakeGitHub(issues: unknown[]): { client: GitHubHttpClient; calls: GitHubHttpRequest[] } {
  const calls: GitHubHttpRequest[] = [];
  const client: GitHubHttpClient = {
    async request(input) {
      calls.push(input);
      return { status: 200, body: githubRows(issues) };
    },
  };
  return { client, calls };
}
function githubRows(rows: unknown[]): unknown[] {
  return rows.map((row) =>
    typeof row === "object" && row !== null && !Array.isArray(row)
      ? { comments: 0, user: { login: "octocat" }, ...row }
      : row,
  );
}

function fakeSentry(issues: unknown[]): { client: SentryHttpClient; calls: SentryHttpRequest[] } {
  const calls: SentryHttpRequest[] = [];
  const client: SentryHttpClient = {
    async request(input) {
      calls.push(input);
      return {
        status: 200,
        body: issues.map((issue) =>
          typeof issue === "object" && issue !== null ? { project: { slug: "app" }, ...issue } : issue,
        ),
        headers: { link: terminalSentryLink(input) },
      };
    },
  };
  return { client, calls };
}

function stubPool(existingSpecs: Array<{ spec_id: string; title: string; status: string }> = []): {
  pool: pg.Pool;
  candidates: Map<string, Record<string, unknown>>;
  specs: Map<string, unknown>;
} {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const specs = new Map<string, unknown>();
  const sources = new Map<string, InboxSource>([
    [issuesSource.id, issuesSource],
    [auditSource.id, auditSource],
    [sentrySource.id, sentrySource],
  ]);

  const candidateRow = (id: string) => {
    const c = candidates.get(id)!;
    const src = sources.get(c.source_id as string)!;
    return { ...c, source_name: src.name, source_kind: src.kind };
  };

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return { rows: existingSpecs, rowCount: existingSpecs.length };
    }
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const existingId = byExternal.get(key);
      const cid = existingId ?? id;
      candidates.set(cid, {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status,
        triage: JSON.parse(triage),
        resolved_spec_id: null,
      });
      byExternal.set(key, cid);
      return { rows: [candidateRow(cid)], rowCount: 1 };
    }
    if (sql.startsWith("SELECT c.id, c.source_id") && sql.includes("WHERE c.id = $1")) {
      const c = candidates.get(String(params[0]));
      return c === undefined ? { rows: [], rowCount: 0 } : { rows: [candidateRow(String(params[0]))], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE candidates c SET status")) {
      const [cid, status, specId] = params as (string | null)[];
      const c = candidates.get(String(cid));
      if (c === undefined) return { rows: [], rowCount: 0 };
      c.status = status;
      c.resolved_spec_id = specId;
      return { rows: [candidateRow(String(cid))], rowCount: 1 };
    }
    if (sql.startsWith("SELECT project_id FROM projects")) {
      return { rows: [{ project_id: params[0] }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_test" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      specs.set(String(params[0]), { metadata: {} });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT metadata FROM specs")) {
      const row = specs.get(String(params[0]));
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE specs SET metadata")) {
      specs.set(String(params[0]), { metadata: JSON.parse(String(params[1])) });
      return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    }
    if (sql.includes("FROM spec_dependencies") || sql.startsWith("INSERT INTO spec_dependencies")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, candidates, specs };
}

function depsFor(connectors: ReadonlyMap<string, SourceConnector>, pool: pg.Pool): InboxEngineDeps {
  return { pool, connectors, answerer: createDeterministicTriageAnswerer() };
}

describe("github issues connector (mocked)", () => {
  it("maps open issues to candidates and drops pull requests", async () => {
    const { client, calls } = fakeGitHub([
      {
        number: 88,
        title: "feature · CSV export",
        body: "cfo wants csv",
        labels: ["spec-candidate"],
      },
      {
        number: 91,
        title: "bug · 500 on pagination",
        body: "stack trace",
        labels: [{ name: "bug" }],
      },
      { number: 92, title: "a PR", pull_request: { url: "x" } },
    ]);
    const connector = githubConnector(client);
    const items = await connector.fetch(issuesSource);
    expect(items).toHaveLength(2);
    expect(items[0]?.externalId).toBe("gh-cat-cave/app#88");
    expect(items[1]?.severity).toBe("fail");
    expect(calls[0]?.path).toContain("labels=spec-candidate");
    expect(calls[0]?.path).toContain("state=open");
  });
});

describe("deterministic triage answerer", () => {
  const answerer = createDeterministicTriageAnswerer();
  const baseCtx = (over: Partial<TriageAnswererContext>): TriageAnswererContext => ({
    candidate: {
      title: "csv export",
      body: "",
      severity: "info",
      sourceKind: "issues",
      projectId: "project_a",
    },
    source: issuesSource,
    existingSpecs: [],
    ...over,
  });

  it("auto-routes system-source candidates with an auto_routable verdict", async () => {
    const t = await answerer.triage(baseCtx({ source: auditSource }));
    expect(t.verdict).toBe("auto_routable");
    expect(t.placement).toContain("auto");
  });

  it("dedupe → close when the candidate matches a shipped spec", async () => {
    const t = await answerer.triage(
      baseCtx({
        candidate: {
          title: "dark mode toggle theme",
          body: "",
          severity: "info",
          sourceKind: "issues",
          projectId: "project_a",
        },
        existingSpecs: [{ specId: "spec_a4f", title: "dark mode toggle theme", status: "merged" }],
      }),
    );
    expect(t.verdict).toBe("dedupe_close");
    expect(t.duplicateOfSpecId).toBe("spec_a4f");
  });

  it("needs_call · fold into the live run when a fail touches an in-flight spec", async () => {
    const t = await answerer.triage(
      baseCtx({
        candidate: {
          title: "500 on orders pagination cursor",
          body: "",
          severity: "fail",
          sourceKind: "errors",
          projectId: "project_a",
        },
        existingSpecs: [{ specId: "spec_b21", title: "orders pagination cursor list", status: "in_flight" }],
      }),
    );
    expect(t.verdict).toBe("needs_call");
    expect(t.placement).toContain("live run");
    expect(t.discoveryVariant).toBe("bug");
  });

  it("needs_call with a proposed placement for a fresh candidate", async () => {
    const t = await answerer.triage(baseCtx({}));
    expect(t.verdict).toBe("needs_call");
    expect(t.match).toContain("new behavior");
  });
});

describe("ingestSource (connector → triage → upsert)", () => {
  it("triages each issue and persists external candidates as triaged", async () => {
    const rawTitle = `  ${"x".repeat(301)}  `;
    const { client } = fakeGitHub([{ number: 88, title: rawTitle, body: "x", labels: [] }]);
    const { pool, candidates } = stubPool();
    const connectors = new Map<string, SourceConnector>([["issues", githubConnector(client)]]);
    const { candidates: out } = await ingestSource(depsFor(connectors, pool), issuesSource);
    const payload = {
      action: "opened",
      issue: { number: 88, title: rawTitle, labels: [] },
      repository: { owner: { login: "cat-cave" }, name: "app" },
    };
    const pushed = mapGithubIssueWebhook(payload, issuesSource);
    if (pushed.kind !== "ingest") throw new Error("expected ingest");
    expect(out).toHaveLength(1);
    expect([out[0]?.status, out[0]?.triage?.verdict, candidates.size]).toEqual(["triaged", "needs_call", 1]);
    expect([out[0]?.externalId, out[0]?.title]).toEqual([pushed.item.externalId, pushed.item.title]);
    expect(pushed.item.title).toBe(`${"x".repeat(299)}…`);
  });
  it.each([false, true])("rejects a duplicate issue number with zero effects (split=%s)", async (split) => {
    const first = { number: 7, title: "first" },
      replay = { number: 7, title: "replay" };
    const pages = split ? [[first], [replay]] : [[first, replay]];
    const nextPath = "/repos/cat-cave/app/issues?state=open&per_page=50&labels=spec-candidate&page=2";
    let calls = 0;
    const client: GitHubHttpClient = {
      request: async () => ({
        status: 200,
        body: githubRows(pages[calls++]!),
        nextPagePath: calls < pages.length ? nextPath : undefined,
      }),
    };
    const { pool, candidates } = stubPool();
    const triage = vi.fn<() => never>();
    await expect(
      ingestSource(
        { pool, connectors: new Map([["issues", githubConnector(client)]]), answerer: { triage } as never },
        issuesSource,
      ),
    ).rejects.toThrow(/repeated an issue number/u);
    expect([calls, candidates.size, triage.mock.calls.length]).toEqual([pages.length, 0, 0]);
  });
  it("auto-routes a system source's findings (status auto_routed)", async () => {
    const connector: SourceConnector = {
      kind: "scheduled_audit",
      fetch: async () => [
        {
          externalId: "a11y-1",
          title: "contrast failure",
          body: "",
          severity: "warn",
          projectId: "project_a",
        },
      ],
    };
    const { pool } = stubPool();
    const connectors = new Map<string, SourceConnector>([["scheduled_audit", connector]]);
    const { candidates: out } = await ingestSource(depsFor(connectors, pool), auditSource);
    expect(out[0]?.status).toBe("auto_routed");
    expect(out[0]?.triage?.verdict).toBe("auto_routable");
  });

  it("is idempotent: re-ingesting the same issue updates rather than duplicates", async () => {
    const issues = [{ number: 88, title: "CSV export", body: "v1", labels: [] }];
    const { client } = fakeGitHub(issues);
    const { pool, candidates } = stubPool();
    const connectors = new Map<string, SourceConnector>([["issues", githubConnector(client)]]);
    const deps = depsFor(connectors, pool);
    await ingestSource(deps, issuesSource);
    issues[0]!.body = "v2";
    await ingestSource(deps, issuesSource);
    expect(candidates.size).toBe(1);
    expect([...candidates.values()][0]?.body).toBe("v2");
  });
});
describe("accept → discovery hand-off", () => {
  it("creates a spec via the discovery accept path and resolves the candidate", async () => {
    const { client } = fakeGitHub([{ number: 88, title: "CSV export", body: "x", labels: [] }]);
    const { pool, specs } = stubPool();
    const connectors = new Map<string, SourceConnector>([["issues", githubConnector(client)]]);
    const deps = depsFor(connectors, pool);
    const { candidates: ingested } = await ingestSource(deps, issuesSource);
    const candidateId = ingested[0]!.id;

    const result = await acceptCandidate(deps, {
      candidateId,
      orgId: "org_a",
      proposals: [
        {
          proposalId: "p1",
          title: "add csv export",
          description: "button + endpoint",
          acceptanceCriteria: ["exports csv"],
          dependsOn: [],
          priority: "P1",
          estLabel: "2h",
        },
      ],
      placementKind: "jump_backlog",
      placementLabel: "jump the p1 backlog",
      actor,
    });
    expect(result.candidate.status).toBe("accepted");
    expect(result.specId).toMatch(/^spec_/u);
    expect(result.candidate.resolvedSpecId).toBe(result.specId);
    expect(specs.size).toBe(1);
  });

  it("dismiss transitions the candidate to dismissed", async () => {
    const { client } = fakeGitHub([{ number: 88, title: "CSV export", body: "x", labels: [] }]);
    const { pool } = stubPool();
    const connectors = new Map<string, SourceConnector>([["issues", githubConnector(client)]]);
    const deps = depsFor(connectors, pool);
    const { candidates: ingested } = await ingestSource(deps, issuesSource);
    const out = await dismissCandidate(deps, ingested[0]!.id);
    expect(out.status).toBe("dismissed");
  });
});

describe("sentry connector (mocked)", () => {
  const sentryIssues = [
    {
      id: "4001",
      shortId: "APP-1",
      title: "TypeError: cannot read property 'id' of undefined",
      culprit: "orders/checkout.ts in submit",
      level: "error",
      permalink: "https://sentry.io/organizations/cat-cave/issues/4001/",
      count: "1287",
      userCount: 42,
      metadata: { type: "TypeError", value: "cannot read property 'id' of undefined" },
    },
    {
      id: "4002",
      title: "slow query on /reports",
      level: "warning",
      permalink: "https://sentry.io/organizations/cat-cave/issues/4002/",
      metadata: { value: "query exceeded 5s" },
    },
  ];

  it("maps unresolved sentry issues to candidates with permalink + metadata body", async () => {
    const { client, calls } = fakeSentry(sentryIssues);
    const connector = sentryConnector(client);
    const items = await connector.fetch(sentrySource);

    expect(items).toHaveLength(2);
    expect(items[0]?.externalId).toBe("sentry-4001");
    expect(items[0]?.title).toContain("TypeError");
    expect(items[0]?.body).toContain("https://sentry.io/organizations/cat-cave/issues/4001/");
    expect(items[0]?.body).toContain("users affected: 42");
    expect(calls[0]?.path).toContain("/api/0/projects/cat-cave/app/issues/");
    expect(calls[0]?.path).toContain("is%3Aunresolved");
    expect(calls[0]?.token).toBe("sntrys_token");
  });

  it("maps sentry level to severity (error→fail, warning→warn, else→info)", async () => {
    const { client } = fakeSentry(sentryIssues);
    const items = await sentryConnector(client).fetch(sentrySource);
    expect(items[0]?.severity).toBe("fail");
    expect(items[1]?.severity).toBe("warn");
  });

  it("forwards an optional level filter into the query", async () => {
    const { client, calls } = fakeSentry([]);
    await sentryConnector(client).fetch({
      ...sentrySource,
      config: { ...sentrySource.config, level: "fatal" },
    });
    expect(calls[0]?.path).toContain("level%3Afatal");
  });

  it("ingests + triages sentry candidates as triaged (needs_call)", async () => {
    const { client } = fakeSentry(sentryIssues);
    const { pool, candidates } = stubPool();
    const connectors = new Map<string, SourceConnector>([["errors", sentryConnector(client)]]);
    const { candidates: out } = await ingestSource(depsFor(connectors, pool), sentrySource);
    expect(out).toHaveLength(2);
    expect(out[0]?.status).toBe("triaged");
    expect(out[0]?.triage?.verdict).toBe("needs_call");
    expect(out[0]?.triage?.discoveryVariant).toBe("bug");
    expect(candidates.size).toBe(2);
  });

  it("routes a sentry fail touching an in-flight spec to fold into the live run", async () => {
    const { client } = fakeSentry([sentryIssues[0]]);
    const { pool } = stubPool([{ spec_id: "spec_co1", title: "orders checkout submit flow", status: "in_flight" }]);
    const connectors = new Map<string, SourceConnector>([["errors", sentryConnector(client)]]);
    const { candidates: out } = await ingestSource(depsFor(connectors, pool), sentrySource);
    expect(out[0]?.triage?.verdict).toBe("needs_call");
    expect(out[0]?.triage?.match).toContain("in-flight");
    expect(out[0]?.triage?.placement).toContain("live run");
  });

  it("is idempotent: re-ingesting the same sentry issue updates rather than duplicates", async () => {
    const issues = [{ id: "4001", title: "TypeError v1", level: "error", permalink: "https://sentry.io/4001/" }];
    const { client } = fakeSentry(issues);
    const { pool, candidates } = stubPool();
    const connectors = new Map<string, SourceConnector>([["errors", sentryConnector(client)]]);
    const deps = depsFor(connectors, pool);
    await ingestSource(deps, sentrySource);
    issues[0]!.title = "TypeError v2";
    await ingestSource(deps, sentrySource);
    expect(candidates.size).toBe(1);
    expect([...candidates.values()][0]?.title).toBe("TypeError v2");
  });
});
