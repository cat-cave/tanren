// Intake credential resolution behavior tests (no-silent-fallbacks fix).
//
// Proves the IssueSource seam (`buildIntakeConnectorMapForOrg`) resolves the
// GitHub credential the SAME way the rest of the engine does — App installation
// token when installed, ELSE the org-default static token — and FAILS LOUD when a
// configured GitHub issues source has no resolvable credential, instead of the
// prior App-token-only silent no-connector:
//   (a) intake configured + credential RESOLVABLE → the poller connector is built
//       (App-token when installed; else the org-default static token) and ingests.
//   (b) intake configured BUT no resolvable credential (App not installed AND no
//       org-default token) → a LOUD `IntakeGithubCredentialMissingError` naming
//       the source, NOT a silent skip.
//   (c) intake genuinely NOT configured (no GitHub issues source) → no poller, no
//       error (the legitimate "no GitHub intake" case).
//   (d) persisted caller-owned authority or deleted-provider poison is parked in
//       durable needs-attention state before secret/provider I/O, exactly once.
//   (e) permanent auth denial is also parked, while later ticks continue.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  buildIntakeConnectorMapForOrg,
  IntakeGithubCredentialMissingError,
  IntakePoller,
  intakeAutoRouteDeps,
} from "../src/engine/forge/intake/index.js";
import { UnsupportedInboxProviderError } from "../src/engine/forge/inbox/index.js";
import type { InboxSource, TriageAnswerer } from "../src/engine/forge/inbox/index.js";

const githubSource: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "",
  config: { owner: "cat-cave", repo: "app" },
  enabled: true,
  autoRoute: false,
};

// An org-config stub pool. `config` is what `SELECT config FROM organizations`
// returns (the `loadOrgGithubAppInstallation` + `loadOrgDefaultGithubCredentialRef`
// reads). BEGIN/SET LOCAL/COMMIT fall through to the empty default.
function orgConfigPool(config: unknown): pg.Pool {
  const query = async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.includes("SELECT config FROM organizations")) {
      return { rows: [{ config }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
}

// A secret store returning a fake token only for the org-default ref.
const ORG_A_GITHUB_REF = "credential/github/org/org_a/default";
const fakeSecrets = {
  get: async (ref: string) => (ref === ORG_A_GITHUB_REF ? { ref, value: "ghs_fake" } : undefined),
} as never;

// A fake GitHub HTTP client returning one open issue, capturing the token used so
// the test asserts the resolved (org-default static) token reached the wire.
function fakeGithubHttp(): { http: never; tokensSeen: string[] } {
  const tokensSeen: string[] = [];
  const http = {
    request: async (input: { token: string }) => {
      tokensSeen.push(input.token);
      return {
        status: 200,
        body: [{ number: 1, title: "polled issue", body: "details", labels: [] }],
      };
    },
  } as never;
  return { http, tokensSeen };
}

describe("intake credential resolution — configured + resolvable", () => {
  it("builds the connector using the org-default static token when no App is installed", async () => {
    // Org has NO App installation but a default static github_token ref.
    const pool = orgConfigPool({ version: 1, defaultCredentials: { github_token: ORG_A_GITHUB_REF } });
    const { http, tokensSeen } = fakeGithubHttp();

    const connectors = await buildIntakeConnectorMapForOrg({ pool, secrets: fakeSecrets, githubHttp: http }, "org_a", [
      githubSource,
    ]);

    const issues = connectors.get("issues");
    expect(issues).toBeDefined();
    const items = await issues!.fetch(githubSource);
    // The connector built and ingested the issue using the resolved static token.
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("polled issue");
    expect(tokensSeen).toEqual(["ghs_fake"]);
  });
});

describe("intake credential resolution — configured but credential missing (LOUD)", () => {
  it("throws IntakeGithubCredentialMissingError naming the source — never a silent skip", async () => {
    // Org has NO App installation AND no org-default github_token.
    const pool = orgConfigPool({ version: 1 });
    const { http } = fakeGithubHttp();

    await expect(
      buildIntakeConnectorMapForOrg({ pool, secrets: fakeSecrets, githubHttp: http }, "org_a", [githubSource]),
    ).rejects.toBeInstanceOf(IntakeGithubCredentialMissingError);

    // The error names the configured source + its org (a loud, actionable failure).
    const error = await buildIntakeConnectorMapForOrg({ pool, secrets: fakeSecrets, githubHttp: http }, "org_a", [
      githubSource,
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntakeGithubCredentialMissingError);
    expect((error as IntakeGithubCredentialMissingError).sourceId).toBe("src_gh");
    expect((error as IntakeGithubCredentialMissingError).orgId).toBe("org_a");
    expect((error as Error).message).toContain("github_token");
  });
});

describe("intake credential resolution — hostile persisted tenant ref", () => {
  it("rejects an old org-B ref before secret or provider I/O", async () => {
    const pool = orgConfigPool({
      version: 1,
      defaultCredentials: { github_token: "credential/github/org/org_b/default" },
    });
    let secretReads = 0;
    let providerCalls = 0;
    await expect(
      buildIntakeConnectorMapForOrg(
        {
          pool,
          secrets: {
            get: async () => {
              secretReads += 1;
            },
          } as never,
          githubHttp: {
            request: async () => {
              providerCalls += 1;
              return { status: 200, body: [] };
            },
          } as never,
        },
        "org_a",
        [githubSource],
      ),
    ).rejects.toThrow("credential ref does not belong to the authenticated owner");
    expect({ secretReads, providerCalls }).toEqual({ secretReads: 0, providerCalls: 0 });
  });
});

describe("intake credential resolution — not configured (legitimate no-poller)", () => {
  it("builds the map with NO error when no GitHub issues source is present", async () => {
    // No org-default token and no App — but ALSO no github issues source, so the
    // org credential is never required: the legitimate "no GitHub intake" case.
    const pool = orgConfigPool({ version: 1 });
    const { http } = fakeGithubHttp();
    const sentrySource: InboxSource = {
      ...githubSource,
      id: "src_sentry",
      kind: "errors",
      name: "sentry · cat-cave",
      config: { org: "cat-cave", project: "app" },
    };

    // No throw — the map builds; Sentry authority is resolved only when it fetches.
    const connectors = await buildIntakeConnectorMapForOrg({ pool, secrets: fakeSecrets, githubHttp: http }, "org_a", [
      sentrySource,
    ]);
    expect(connectors.get("errors")).toBeDefined();
  });
});

// Map a source to its persisted row shape (the poller reads sources back).
function sourceRow(s: InboxSource): Record<string, unknown> {
  return {
    id: s.id,
    org_id: s.orgId,
    project_id: s.projectId,
    kind: s.kind,
    name: s.name,
    detail: s.detail,
    config: s.config,
    enabled: s.enabled ? "true" : "false",
    auto_route: s.autoRoute ? "true" : "false",
  };
}

interface PollerStub {
  pool: pg.Pool;
  eventTypes: string[];
  terminalWrites: { value: number };
}

// Stateful full-poller stub: a terminal UPDATE disables the row, so a second
// tick proves it is not retried. Event INSERTs prove the durable EventStore path.
function pollerStubPool(source: InboxSource, orgConfig: unknown): PollerStub {
  let current = source;
  const eventTypes: string[] = [];
  const terminalWrites = { value: 0 };
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT DISTINCT org_id FROM inbox_sources")) {
      return current.enabled ? { rows: [{ org_id: current.orgId }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM inbox_sources WHERE org_id = $1")) {
      return current.enabled ? { rows: [sourceRow(current)], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT config FROM organizations")) {
      return { rows: [{ config: orgConfig }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE inbox_sources SET config") && sql.includes("enabled = 'false'")) {
      terminalWrites.value += 1;
      current = { ...current, config: JSON.parse(String(params[2])) as Record<string, unknown>, enabled: false };
      return { rows: [sourceRow(current)], rowCount: 1 };
    }
    if (sql.includes("event_type, payload") && sql.includes("RETURNING id::text AS id")) {
      eventTypes.push(String(params[5]));
      return { rows: [{ id: String(eventTypes.length) }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
  return { pool, eventTypes, terminalWrites };
}

const fixedTriage: TriageAnswerer = {
  triage: async () => ({
    dedupe: "no match",
    match: "new",
    placement: "auto",
    verdict: "needs_call",
    duplicateOfSpecId: null,
    discoveryVariant: "feature",
    routableSpec: null,
  }),
};

describe("intake credential resolution — source-owned staticRef is terminal poison", () => {
  it("parks a foreign staticRef exactly once without secret or provider I/O", async () => {
    const staticRefSource: InboxSource = {
      ...githubSource,
      config: { owner: "cat-cave", repo: "app", staticRef: "credential/github/org/org_b/default" },
    };
    const stub = pollerStubPool(staticRefSource, { version: 1 });
    let secretReads = 0;
    let providerCalls = 0;
    const poller = new IntakePoller(
      {
        pool: stub.pool,
        secrets: {
          get: async () => {
            secretReads += 1;
          },
        } as never,
        githubHttp: {
          request: async () => {
            providerCalls += 1;
            return { status: 200, body: [] };
          },
        } as never,
        answererFactory: () => fixedTriage,
        autoRoute: intakeAutoRouteDeps(),
      },
      60_000,
    );
    await expect(poller.tick()).resolves.toEqual([]);
    await expect(poller.tick()).resolves.toEqual([]);
    expect({ secretReads, providerCalls }).toEqual({ secretReads: 0, providerCalls: 0 });
    expect(stub.terminalWrites.value).toBe(1);
    expect(stub.eventTypes).toEqual(["credential.failed"]);
  });
});

describe("intake fetch auth — permanent denial reaches durable attention", () => {
  it("parks a denied organization-bound credential instead of retrying forever", async () => {
    const stub = pollerStubPool(githubSource, {
      version: 1,
      defaultCredentials: { github_token: ORG_A_GITHUB_REF },
    });
    const secrets = {
      get: async (ref: string) => (ref === ORG_A_GITHUB_REF ? { ref, value: "ghs_live_but_denied" } : undefined),
    } as never;
    const deniedHttp = {
      request: async () => ({ status: 401, body: { message: "Bad credentials" } }),
    } as never;
    const poller = new IntakePoller(
      {
        pool: stub.pool,
        secrets,
        githubHttp: deniedHttp,
        answererFactory: () => fixedTriage,
        autoRoute: intakeAutoRouteDeps(),
      },
      60_000,
    );

    await expect(poller.tick()).resolves.toEqual([]);
    await expect(poller.tick()).resolves.toEqual([]);
    expect(stub.terminalWrites.value).toBe(1);
    expect(stub.eventTypes).toEqual(["credential.failed"]);
  });
});

describe("intake provider resolution — removed provider becomes durable attention", () => {
  it("parks an unsupported provider without secret/provider I/O or perpetual retry", async () => {
    const removedProviderSource: InboxSource = {
      ...githubSource,
      config: { provider: "jira", baseUrl: "https://jira.example", projectKey: "ENG" },
    };
    const stub = pollerStubPool(removedProviderSource, { version: 1 });
    let secretReads = 0;
    const secrets = {
      get: async () => {
        secretReads += 1;
      },
    } as never;
    let providerCalls = 0;
    const http = {
      request: async () => {
        providerCalls += 1;
        return { status: 200, body: [] };
      },
    } as never;
    const poller = new IntakePoller(
      {
        pool: stub.pool,
        secrets,
        githubHttp: http,
        answererFactory: () => fixedTriage,
        autoRoute: intakeAutoRouteDeps(),
      },
      60_000,
    );

    await expect(poller.tick()).resolves.toEqual([]);
    await expect(poller.tick()).resolves.toEqual([]);
    expect(secretReads).toBe(0);
    expect(providerCalls).toBe(0);
    expect(stub.terminalWrites.value).toBe(1);
    expect(stub.eventTypes).toEqual(["credential.failed"]);
  });
});

describe("poller convergence — permanent failure cannot starve later sources", () => {
  it("parks the first source, polls the next on every due tick, and still runs both sweepers", async () => {
    const bad: InboxSource = { ...githubSource, id: "src_bad", name: "bad" };
    const good: InboxSource = { ...githubSource, id: "src_good", name: "good" };
    let badEnabled = true;
    let terminalWrites = 0;
    const eventTypes: string[] = [];
    let webhookSweeps = 0;
    let candidateSweeps = 0;
    const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
      const sql = text.replaceAll(/\s+/gu, " ").trim();
      if (sql.startsWith("SELECT DISTINCT org_id FROM inbox_sources")) {
        return { rows: [{ org_id: "org_a" }], rowCount: 1 };
      }
      if (sql.includes("FROM inbox_sources WHERE org_id = $1")) {
        const sources = [...(badEnabled ? [bad] : []), good];
        return { rows: sources.map((source) => sourceRow(source)), rowCount: sources.length };
      }
      if (sql.startsWith("UPDATE inbox_sources SET config") && sql.includes("enabled = 'false'")) {
        badEnabled = false;
        terminalWrites += 1;
        const parked = {
          ...bad,
          enabled: false,
          config: JSON.parse(String(params[2])) as Record<string, unknown>,
        };
        return { rows: [sourceRow(parked)], rowCount: 1 };
      }
      if (sql.includes("event_type, payload") && sql.includes("RETURNING id::text AS id")) {
        eventTypes.push(String(params[5]));
        return { rows: [{ id: String(eventTypes.length) }], rowCount: 1 };
      }
      if (sql.includes("FROM webhook_events")) {
        webhookSweeps += 1;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM candidates c JOIN inbox_sources")) {
        candidateSweeps += 1;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
    let badCalls = 0;
    let goodCalls = 0;
    const connector = {
      kind: "issues" as const,
      async fetch(source: InboxSource) {
        if (source.id === bad.id) {
          badCalls += 1;
          throw new UnsupportedInboxProviderError("jira", "deleted provider");
        }
        goodCalls += 1;
        return [];
      },
    };
    let now = 1_000_000;
    const poller = new IntakePoller(
      {
        pool,
        secrets: {} as never,
        githubHttp: {} as never,
        connectors: new Map([["issues", connector]]),
        answererFactory: () => fixedTriage,
        autoRoute: intakeAutoRouteDeps(),
        now: () => now,
      },
      60_000,
    );

    expect((await poller.tick()).map((result) => result.source.id)).toEqual([good.id]);
    now += 6 * 60_000;
    expect((await poller.tick()).map((result) => result.source.id)).toEqual([good.id]);
    expect({ badCalls, goodCalls, terminalWrites }).toEqual({ badCalls: 1, goodCalls: 2, terminalWrites: 1 });
    expect(eventTypes).toEqual(["credential.failed"]);
    expect({ webhookSweeps, candidateSweeps }).toEqual({ webhookSweeps: 2, candidateSweeps: 2 });
  });
});
