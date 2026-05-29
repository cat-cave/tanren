// Linear inbox connector + `issues` provider-dispatcher tests.
//
// Exercises the Linear connector (MOCKED LinearHttpClient + secrets — no
// network / no live token): the GraphQL → IngestedItem mapping, priority/label
// → severity, the optional label filter, idempotent re-ingest, and triage
// through the ingest pipeline. It also exercises the `issues` dispatcher that
// routes by `config.provider` (github default vs linear) so the GitHub
// connector keeps working alongside Linear under the same source kind. The pool
// is a lightweight in-memory stub keyed by SQL substring, mirroring the sibling
// candidateInbox.test.ts.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import {
  createGitHubIssuesConnector,
  createIssuesConnector,
  createLinearConnector,
  ingestSource,
  type InboxEngineDeps,
  type InboxSource,
  type LinearHttpClient,
  type LinearHttpRequest,
  type SourceConnector
} from "../src/engine/forge/inbox/index.js";

// A Linear source wired under the `issues` kind (dispatch by config.provider).
const linearSource: InboxSource = {
  id: "src_linear",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "linear · cat-cave",
  detail: "open issues",
  config: { provider: "linear", tokenRef: "credential/linear/x", teamId: "team_1" },
  enabled: true,
  autoRoute: false
};

// A GitHub source under the same `issues` kind, with no provider field (the
// shape existing sources carry).
const githubSource: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "issues labeled spec-candidate",
  config: { owner: "cat-cave", repo: "app", labels: ["spec-candidate"], staticRef: "credential/github/x" },
  enabled: true,
  autoRoute: false
};

const secrets = new InMemorySecretStore();
await secrets.put({ ref: "credential/github/x", value: "ghs_token" });
await secrets.put({ ref: "credential/linear/x", value: "lin_api_token" });

// A fake LinearHttpClient returning a fixed GraphQL issue list (no network/
// token). The body mirrors Linear's `{ data: { issues: { nodes } } }` envelope.
function fakeLinear(nodes: unknown[]): { client: LinearHttpClient; calls: LinearHttpRequest[] } {
  const calls: LinearHttpRequest[] = [];
  const client: LinearHttpClient = {
    async request(input) {
      calls.push(input);
      return { status: 200, body: { data: { issues: { nodes } } } };
    }
  };
  return { client, calls };
}

function fakeGitHub(issues: unknown[]): GitHubHttpClient {
  return {
    async request() {
      return { status: 200, body: issues };
    }
  };
}

// In-memory pool that tracks candidates so the ingest upsert is observable.
function stubPool(): { pool: pg.Pool; candidates: Map<string, Record<string, unknown>> } {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const sources = new Map<string, InboxSource>([
    [linearSource.id, linearSource],
    [githubSource.id, githubSource]
  ]);
  const candidateRow = (id: string) => {
    const c = candidates.get(id)!;
    const src = sources.get(c.source_id as string)!;
    return { ...c, source_name: src.name, source_kind: src.kind };
  };
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const cid = byExternal.get(key) ?? id;
      candidates.set(cid, {
        id: cid, source_id: sourceId, org_id: orgId, project_id: projectId, external_id: externalId,
        title, body, severity, status, triage: JSON.parse(triage), resolved_spec_id: null
      });
      byExternal.set(key, cid);
      return { rows: [candidateRow(cid)], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query } as unknown as pg.Pool, candidates };
}

function depsFor(connectors: ReadonlyMap<string, SourceConnector>, pool: pg.Pool): InboxEngineDeps {
  return { pool, connectors };
}

const linearIssues = [
  {
    id: "lin_aaa",
    identifier: "CAT-12",
    title: "checkout crashes on empty cart",
    description: "repro: clear cart then submit",
    url: "https://linear.app/cat-cave/issue/CAT-12",
    priority: 1, // Urgent
    labels: { nodes: [{ name: "Bug" }] }
  },
  {
    id: "lin_bbb",
    identifier: "CAT-13",
    title: "CSV export for reports",
    description: "cfo wants csv",
    url: "https://linear.app/cat-cave/issue/CAT-13",
    priority: 2, // High
    labels: { nodes: [{ name: "feature" }] }
  },
  {
    id: "lin_ccc",
    identifier: "CAT-14",
    title: "tidy up settings copy",
    description: "",
    url: "https://linear.app/cat-cave/issue/CAT-14",
    priority: 0, // No priority
    labels: { nodes: [] }
  },
  // A degenerate node with neither id nor title — must be dropped.
  { priority: 3 }
];

describe("linear connector (mocked)", () => {
  it("maps open linear issues to candidates with description + url body", async () => {
    const { client, calls } = fakeLinear(linearIssues);
    const items = await createLinearConnector({ secrets, linearHttp: client }).fetch(linearSource);

    expect(items).toHaveLength(3);
    // externalId is the stable Linear issue id (idempotency key).
    expect(items[0]?.externalId).toBe("linear-lin_aaa");
    expect(items[0]?.title).toBe("checkout crashes on empty cart");
    // body carries the description + Linear deep link for downstream triage.
    expect(items[0]?.body).toContain("repro: clear cart then submit");
    expect(items[0]?.body).toContain("https://linear.app/cat-cave/issue/CAT-12");
    // the request hit the Linear GraphQL endpoint with the token from secrets,
    // scoped to the configured team.
    expect(calls[0]?.endpoint).toBe("https://api.linear.app/graphql");
    expect(calls[0]?.token).toBe("lin_api_token");
    expect(calls[0]?.variables["filter"]).toMatchObject({ team: { id: { eq: "team_1" } } });
  });

  it("maps linear priority/labels to severity (urgent/bug→fail, high→warn, else→info)", async () => {
    const { client } = fakeLinear(linearIssues);
    const items = await createLinearConnector({ secrets, linearHttp: client }).fetch(linearSource);
    expect(items[0]?.severity).toBe("fail"); // priority 1 (urgent) + bug label
    expect(items[1]?.severity).toBe("warn"); // priority 2 (high)
    expect(items[2]?.severity).toBe("info"); // no priority, no label
  });

  it("filters issues by a configured label", async () => {
    const { client } = fakeLinear(linearIssues);
    const items = await createLinearConnector({ secrets, linearHttp: client }).fetch({
      ...linearSource,
      config: { ...linearSource.config, labels: ["bug"] }
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe("linear-lin_aaa");
  });

  it("throws when the configured token ref is missing from the secret store", async () => {
    const { client } = fakeLinear([]);
    await expect(
      createLinearConnector({ secrets, linearHttp: client }).fetch({
        ...linearSource,
        config: { ...linearSource.config, tokenRef: "credential/linear/missing" }
      })
    ).rejects.toThrow(/no secret at ref/);
  });

  it("ingests + triages linear candidates as triaged (fail → bug variant)", async () => {
    const { client } = fakeLinear(linearIssues);
    const { pool, candidates } = stubPool();
    const connectors = new Map<string, SourceConnector>([["issues", createLinearConnector({ secrets, linearHttp: client })]]);
    const { candidates: out } = await ingestSource(depsFor(connectors, pool), linearSource);
    expect(out).toHaveLength(3);
    expect(out[0]?.status).toBe("triaged");
    expect(out[0]?.triage?.verdict).toBe("needs_call");
    expect(out[0]?.triage?.discoveryVariant).toBe("bug");
    expect(candidates.size).toBe(3);
  });

  it("is idempotent: re-ingesting the same linear issue updates rather than duplicates", async () => {
    const nodes = [{ id: "lin_aaa", title: "v1", url: "https://linear.app/x", priority: 0 }];
    const { client } = fakeLinear(nodes);
    const { pool, candidates } = stubPool();
    const connectors = new Map<string, SourceConnector>([["issues", createLinearConnector({ secrets, linearHttp: client })]]);
    const deps = depsFor(connectors, pool);
    await ingestSource(deps, linearSource);
    nodes[0]!.title = "v2";
    await ingestSource(deps, linearSource);
    expect(candidates.size).toBe(1);
    expect([...candidates.values()][0]?.title).toBe("v2");
  });
});

describe("issues dispatcher (provider routing)", () => {
  const dispatcher = () =>
    createIssuesConnector({
      github: createGitHubIssuesConnector({ secrets, githubHttp: fakeGitHub([{ number: 1, title: "gh issue", body: "", labels: [] }]) }),
      linear: createLinearConnector({ secrets, linearHttp: fakeLinear([{ id: "lin_z", title: "lin issue", url: "https://linear.app/z", priority: 0 }]).client })
    });

  it("routes config.provider=linear to the Linear connector", async () => {
    const items = await dispatcher().fetch(linearSource);
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe("linear-lin_z");
  });

  it("defaults to GitHub when no provider is set (existing sources keep working)", async () => {
    const items = await dispatcher().fetch(githubSource);
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe("gh-cat-cave/app#1");
  });

  it("routes config.provider=github explicitly to the GitHub connector", async () => {
    const items = await dispatcher().fetch({ ...githubSource, config: { ...githubSource.config, provider: "github" } });
    expect(items[0]?.externalId).toBe("gh-cat-cave/app#1");
  });
});
