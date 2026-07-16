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
//   (d) intake configured with a SOURCE-OWNED `config.staticRef` that does NOT
//       resolve (the secret store has no secret at that ref) → `IntakePoller.tick()`
//       throws LOUD, NOT a silent skip. The org-default path is loud via the eager
//       seam check; the source-static path is loud via the lazy resolver error
//       (`MissingGithubCredentialRefError`) re-thrown at the tick boundary.
//   (e) a persisted removed-provider/raw-token issues source → a LOUD
//       `UnsupportedInboxProviderError`, never a forever-retried source.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  buildIntakeConnectorMapForOrg,
  IntakeGithubCredentialMissingError,
  IntakePoller,
  intakeAutoRouteDeps,
} from "../src/engine/forge/intake/index.js";
import { MissingGithubCredentialRefError } from "../src/engine/credentials/githubTokenResolver.js";
import { IntakeSourceAuthError, UnsupportedInboxProviderError } from "../src/engine/forge/inbox/index.js";
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
const fakeSecrets = {
  get: async (ref: string) => (ref === "gh/org" ? { ref, value: "ghs_fake" } : undefined),
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
    const pool = orgConfigPool({ version: 1, defaultCredentials: { github_token: "gh/org" } });
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

// A stub pool that drives a full `IntakePoller.tick()`: it lists the one source
// (distinct-org + per-org list) and serves the org-config read (no App, no
// org-default). The connector is rebuilt per-org (NO fixed `connectors` map), so
// the source's own `config.staticRef` flows into the real GitHub connector.
function pollerStubPool(source: InboxSource, orgConfig: unknown): pg.Pool {
  const query = async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT DISTINCT org_id FROM inbox_sources")) {
      return { rows: [{ org_id: source.orgId }], rowCount: 1 };
    }
    if (sql.includes("FROM inbox_sources WHERE org_id = $1")) {
      return { rows: [sourceRow(source)], rowCount: 1 };
    }
    if (sql.includes("SELECT config FROM organizations")) {
      return { rows: [{ config: orgConfig }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
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

describe("intake credential resolution — source-owned staticRef unresolvable (LOUD)", () => {
  it("tick() throws (loud) when a github source's config.staticRef does not resolve — never a silent skip", async () => {
    // The source pins its OWN staticRef (so the eager seam check passes — it does
    // not require an org-default), but the secret store has NO secret at that ref.
    // The lazy `resolveGithubToken` then raises MissingGithubCredentialRefError
    // inside the connector's fetch; the poller must re-throw it loud, not swallow.
    const staticRefSource: InboxSource = {
      ...githubSource,
      config: { owner: "cat-cave", repo: "app", staticRef: "gh/broken" },
    };
    // No App, no org-default — and the store returns undefined for "gh/broken".
    const pool = pollerStubPool(staticRefSource, { version: 1 });
    const { http } = fakeGithubHttp();
    const poller = new IntakePoller(
      {
        pool,
        secrets: fakeSecrets,
        githubHttp: http,
        answererFactory: () => fixedTriage,
        autoRoute: intakeAutoRouteDeps(),
      },
      60_000,
    );

    // The credential-resolution error surfaces LOUD at the tick boundary, NOT
    // swallowed as a per-source transient (which would silently never ingest).
    await expect(poller.tick()).rejects.toBeInstanceOf(MissingGithubCredentialRefError);
  });
});

describe("intake fetch auth — a connector 401/403 surfaces LOUD at the tick boundary", () => {
  it("tick() re-throws IntakeSourceAuthError — a denied fetch is NOT swallowed as a per-source transient", async () => {
    // The source's staticRef DOES resolve (a real token), so the connector reaches
    // the HTTP call — but GitHub rejects it with a 401. Per the no-silent-fallbacks
    // doctrine that is a credential-resolution failure (the token is revoked/wrong),
    // classed alongside the resolver errors so the poller re-throws it LOUD instead
    // of swallowing it as "this source simply had no issues this tick".
    const staticRefSource: InboxSource = {
      ...githubSource,
      config: { owner: "cat-cave", repo: "app", staticRef: "gh/live" },
    };
    const pool = pollerStubPool(staticRefSource, { version: 1 });
    const secrets = {
      get: async (ref: string) => (ref === "gh/live" ? { ref, value: "ghs_live_but_denied" } : undefined),
    } as never;
    const deniedHttp = {
      request: async () => ({ status: 401, body: { message: "Bad credentials" } }),
    } as never;
    const poller = new IntakePoller(
      {
        pool,
        secrets,
        githubHttp: deniedHttp,
        answererFactory: () => fixedTriage,
        autoRoute: intakeAutoRouteDeps(),
      },
      60_000,
    );

    await expect(poller.tick()).rejects.toBeInstanceOf(IntakeSourceAuthError);
  });
});

describe("intake provider resolution — removed provider config surfaces LOUD", () => {
  it("tick() re-throws an unsupported provider without secret/provider I/O or perpetual retry", async () => {
    const removedProviderSource: InboxSource = {
      ...githubSource,
      config: { provider: "jira", baseUrl: "https://jira.example", projectKey: "ENG" },
    };
    const pool = pollerStubPool(removedProviderSource, { version: 1 });
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
        pool,
        secrets,
        githubHttp: http,
        answererFactory: () => fixedTriage,
        autoRoute: intakeAutoRouteDeps(),
      },
      60_000,
    );

    await expect(poller.tick()).rejects.toBeInstanceOf(UnsupportedInboxProviderError);
    expect(secretReads).toBe(0);
    expect(providerCalls).toBe(0);
  });
});
