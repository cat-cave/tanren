import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  createSentryConnector,
  ingestSource,
  IntakeSourceAuthorityError,
  type InboxSource,
  type SentryHttpClient,
  type SentryHttpRequest,
  type SentryHttpResponse,
} from "../src/engine/forge/inbox/index.js";
import { testSentryIntakeAuthority } from "./helpers/sentryIntakeAuthority.js";
const credentialRef = "credential/sentry/pagination/g/1";
const source: InboxSource = {
  id: "source-sentry",
  orgId: "org-1",
  projectId: "project-1",
  kind: "errors",
  name: "Sentry issues",
  detail: "unresolved",
  config: { org: "cat-cave", project: "app", baseUrl: "https://sentry.io" },
  enabled: true,
  autoRoute: false,
};
const authority = testSentryIntakeAuthority(credentialRef, {
  orgSlug: "cat-cave",
  baseUrl: "https://sentry.io",
});
const issuesUrl = "https://sentry.io/api/0/projects/cat-cave/app/issues/";
const fixedQuery = "query=is%3Aunresolved&statsPeriod=14d";
const issue = (id: string) => ({ id, title: id });
function nextLink(cursor: string, results: boolean, target = `${issuesUrl}?${fixedQuery}&cursor=${cursor}`): string {
  return (
    `<${issuesUrl}?${fixedQuery}&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ` +
    `<${target}>; rel="next"; results="${String(results)}"; cursor="${cursor}"`
  );
}
function page(body: unknown, link?: string): SentryHttpResponse {
  return { status: 200, body, headers: { link } };
}
async function harness(responses: SentryHttpResponse[], intakeAuthority = authority) {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: credentialRef, value: "sentry-token" });
  const calls: SentryHttpRequest[] = [];
  const http: SentryHttpClient = {
    request: async (input) => {
      calls.push(input);
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected Sentry request");
      return response;
    },
  };
  return {
    connector: createSentryConnector({ secrets, sentryHttp: http, authority: intakeAuthority }),
    calls,
    secrets,
  };
}
async function expectNoPersistence(
  connector: ReturnType<typeof createSentryConnector>,
  input = source,
  error: RegExp = /Invalid input/u,
): Promise<void> {
  const query = vi.fn<() => Promise<void>>(async () => {});
  await expect(
    ingestSource(
      {
        pool: { query } as never,
        connectors: new Map([["errors", connector]]),
        answerer: { triage: async () => ({}) } as never,
      },
      input,
    ),
  ).rejects.toThrow(error);
  expect(query).not.toHaveBeenCalled();
}
describe("Sentry cursor pagination fail-closed", () => {
  it("NEGATIVE CONTROL — rejects a malformed later page without persisting the valid prefix", async () => {
    const { connector, calls } = await harness([
      page([{ id: "issue-1", title: "valid first page" }], nextLink("0:100:0", true)),
      page([{ id: 2, title: "malformed second page" }], nextLink("0:200:0", false)),
    ]);
    await expectNoPersistence(connector);
    expect(calls[1]?.path).toBe(
      "/api/0/projects/cat-cave/app/issues/?query=is%3Aunresolved&statsPeriod=14d&cursor=0:100:0",
    );
  });
  const terminal = nextLink("0:100:0", false);
  const nextOnly = terminal.split(", ")[1];
  const duplicateCursor = terminal.replace('cursor="0:100:0"', 'cursor="0:100:0"; cursor="0:100:0"');
  const malformedLinks: [string, string, RegExp][] = [
    ["duplicate relation", `${terminal}, ${nextOnly}`, /exactly one previous and one next/u],
    ["unknown parameter", terminal.replace('rel="next"', 'rel="next"; extra="x"'), /exactly rel/u],
    ["duplicate cursor parameter", duplicateCursor, /duplicate/u],
    ["mismatched cursor parameter", terminal.replace('cursor="0:100:0"', 'cursor="wrong"'), /disagrees/u],
  ];
  it.each(malformedLinks)("rejects %s before any candidate write", async (_name, link, message) => {
    const { connector, calls } = await harness([page([issue("issue-1")], link)]);
    await expectNoPersistence(connector, source, message);
    expect(calls).toHaveLength(1);
  });
  it("rejects an encoded-NUL structural query collision before another request or persistence", async () => {
    const configuredQuery = "query=is%3Aunresolved%00x&statsPeriod=14d";
    const maliciousQuery = "query%00is%3Aunresolved=x&statsPeriod=14d";
    const link =
      `<${issuesUrl}?${configuredQuery}&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ` +
      `<${issuesUrl}?${maliciousQuery}&cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"`;
    const { connector, calls } = await harness([page([issue("issue-1")], link)]);
    await expectNoPersistence(
      connector,
      { ...source, config: { ...source.config, query: "is:unresolved\u0000x" } },
      /configured query multiset/u,
    );
    expect(calls).toHaveLength(1);
  });
});
describe("Sentry intake authority effect binding", () => {
  it("rejects an attacker endpoint before secret resolution or provider I/O", async () => {
    const { connector, calls, secrets } = await harness([]);
    const secretRead = vi.spyOn(secrets, "get");
    const config = { ...source.config, baseUrl: "https://attacker.example" };
    await expect(connector.fetch({ ...source, config })).rejects.toBeInstanceOf(IntakeSourceAuthorityError);
    expect(secretRead).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    secretRead.mockRestore();
  });
});
