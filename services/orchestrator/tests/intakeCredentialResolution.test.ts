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

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { buildIntakeConnectorMapForOrg, IntakeGithubCredentialMissingError } from "../src/engine/forge/intake/index.js";
import type { InboxSource } from "../src/engine/forge/inbox/index.js";

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
      config: { org: "cat-cave", project: "app", tokenRef: "sentry/tok" },
    };

    // No throw — the map builds (the sentry connector carries its own token ref).
    const connectors = await buildIntakeConnectorMapForOrg({ pool, secrets: fakeSecrets, githubHttp: http }, "org_a", [
      sentrySource,
    ]);
    expect(connectors.get("errors")).toBeDefined();
  });
});
