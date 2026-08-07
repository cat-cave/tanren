import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  createSentryConnector,
  InboxSource,
  ingestSource,
  type SentryHttpClient,
  type SentryHttpRequest,
  type SentryHttpResponse,
} from "../src/engine/forge/inbox/index.js";
import { testSentryIntakeAuthority } from "./helpers/sentryIntakeAuthority.js";
const credentialRef = "credential/sentry/pagination/g/1";
const source = InboxSource.parse({
  id: "source-sentry",
  orgId: "org-1",
  projectId: "project-1",
  kind: "errors",
  name: "Sentry issues",
  config: { org: "cat-cave", project: "app", baseUrl: "https://sentry.io" },
});
const authority = testSentryIntakeAuthority(credentialRef, { orgSlug: "cat-cave", baseUrl: "https://sentry.io" });
const issuesUrl = "https://sentry.io/api/0/projects/cat-cave/app/issues/";
const fixedQuery = "query=is%3Aunresolved&statsPeriod=14d";
const issue = (id: string) => ({ id, title: id, project: { slug: "app" } });
function nextLink(cursor: string, results: boolean, target = `${issuesUrl}?${fixedQuery}&cursor=${cursor}`): string {
  return (
    `<${issuesUrl}?${fixedQuery}&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ` +
    `<${target}>; rel="next"; results="${String(results)}"; cursor="${cursor}"`
  );
}
const page = (body: unknown, link?: string): SentryHttpResponse => ({ status: 200, body, headers: { link } });
async function harness(responses: SentryHttpResponse[]) {
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
  return { connector: createSentryConnector({ secrets, sentryHttp: http, authority }), calls };
}
async function expectNoPersistence(
  connector: ReturnType<typeof createSentryConnector>,
  input = source,
  error: RegExp = /Invalid input/u,
): Promise<void> {
  const effect = vi.fn<() => Promise<object>>(async () => ({}));
  await expect(
    ingestSource(
      {
        pool: { query: effect } as never,
        connectors: new Map([["errors", connector]]),
        answerer: { triage: effect } as never,
      },
      input,
    ),
  ).rejects.toThrow(error);
  expect(effect).not.toHaveBeenCalled();
}
describe("Sentry cursor pagination fail-closed", () => {
  it.each([
    ["a malformed later row", { ...issue("issue-2"), id: 2 }, /Invalid input/u],
    ["a whitespace title", { ...issue("issue-2"), title: " \t", culprit: "fallback" }, /Too small/u],
    ["a mixed-project later row", { ...issue("issue-2"), project: { slug: "other" } }, /configured project/u],
    ["a duplicate id", { ...issue("issue-1"), title: "replayed" }, /repeated an issue id/u],
  ])("NEGATIVE CONTROL — rejects %s without exposing the valid prefix", async (_name, badRow, error) => {
    const { connector, calls } = await harness([
      page([issue("issue-1")], nextLink("0:100:0", true)),
      page([badRow], nextLink("0:200:0", false)),
    ]);
    await expectNoPersistence(connector, source, error);
    expect(calls[1]?.path).toContain("cursor=0:100:0");
  });
  const terminal = nextLink("0:100:0", false);
  it.each([
    ["duplicate relation", `${terminal}, ${terminal.split(", ")[1]}`, /exactly one previous and one next/u],
    ["unknown parameter", terminal.replace('rel="next"', 'rel="next"; extra="x"'), /exactly rel/u],
    ["mismatched cursor parameter", terminal.replace('cursor="0:100:0"', 'cursor="wrong"'), /disagrees/u],
    ["non-advancing first cursor", nextLink("0:0:1", true), /did not make progress/u],
  ] as [string, string, RegExp][])("rejects %s before any candidate write", async (_name, link, message) => {
    const { connector, calls } = await harness([page([issue("issue-1")], link)]);
    await expectNoPersistence(connector, source, message);
    expect(calls).toHaveLength(1);
  });
  it("accepts a page-local previous cursor and reads every page", async () => {
    // Sentry's `previous` cursor is page-local: page 2 legitimately advertises a
    // predecessor cursor (`0:100:1`) different from page 1's (`0:0:1`). This is a
    // NORMAL multi-page response and must NOT be rejected — every page is read.
    const secondPage =
      `<${issuesUrl}?${fixedQuery}&cursor=0:100:1>; rel="previous"; results="true"; cursor="0:100:1", ` +
      `<${issuesUrl}?${fixedQuery}&cursor=0:200:0>; rel="next"; results="false"; cursor="0:200:0"`;
    const { connector, calls } = await harness([
      page([issue("issue-1")], nextLink("0:100:0", true)),
      page([issue("issue-2")], secondPage),
    ]);
    const items = await connector.fetch(source);
    expect(items.map((item) => item.externalId)).toEqual(["sentry-issue-1", "sentry-issue-2"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toContain("cursor=0:100:0");
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
