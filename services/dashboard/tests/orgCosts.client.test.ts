import { describe, expect, it } from "vitest";
import { OrchestratorClient } from "../src/api/orchestrator.js";

type FetchImpl = typeof fetch;

const NETWORK_FAILURE: FetchImpl = async () => {
  throw new Error("offline");
};

const RUN = {
  runId: "run_1",
  specId: "spec_1",
  projectId: "project_1",
  branch: "main",
  trigger: "operator",
  status: "completed",
  outcome: "ok",
  startedAt: "2026-05-01T00:00:00.000Z",
  endedAt: "2026-05-01T00:01:00.000Z",
  prUrl: null,
  specTitle: "One",
  costTotalUsd: "1.25",
  lastEventAt: null,
  needsReview: false,
} as const;

const COST = {
  id: "9007199254740993",
  runId: "run_1",
  taskId: "task_1",
  projectId: "project_1",
  cli: "codex",
  provider: "openai",
  model: "gpt",
  inputTokens: 3,
  cachedInputTokens: 2,
  cacheCreationTokens: 1,
  outputTokens: 4,
  reasoningOutputTokens: 5,
  totalTokens: 15,
  costUsd: "1.25",
  notionalCostUsd: "2.50",
  billingMode: "per_token",
  costBasis: "provider_response",
  recordedAt: "2026-05-01T00:00:30.000Z",
} as const;

function client(fetchImpl: FetchImpl): OrchestratorClient {
  return new OrchestratorClient({ orchestratorUrl: "http://orch", cookieHeader: "tanren_session=x", fetchImpl });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fetchPages(...pages: Response[]): { fetchImpl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl: FetchImpl = async (input) => {
    calls.push(typeof input === "string" ? input : input.toString());
    const response = pages[index];
    index += 1;
    if (response === undefined) throw new Error("unexpected request");
    return response;
  };
  return { fetchImpl, calls };
}

describe("OrchestratorClient.getOrgCosts", () => {
  it("returns a valid empty ledger only from a strict terminal 200", async () => {
    const { fetchImpl } = fetchPages(json({ orgId: "org_acme", costs: [], runs: [], nextCursor: null }));
    await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "ok",
      data: { orgId: "org_acme", costs: [], runs: [] },
    });
  });

  it("walks bounded pages to exhaustion and preserves bigint ids exactly", async () => {
    const run2 = { ...RUN, runId: "run_2", projectId: "project_2", specId: "spec_2", specTitle: "Two" };
    const cost2 = { ...COST, id: "9007199254740994", runId: "run_2", projectId: "project_2" };
    const { fetchImpl, calls } = fetchPages(
      json({ orgId: "org_acme", costs: [COST], runs: [RUN], nextCursor: "cursor-2" }),
      json({ orgId: "org_acme", costs: [cost2], runs: [run2], nextCursor: null }),
    );
    const result = await client(fetchImpl).getOrgCosts("org_acme");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok result");
    expect(result.data.costs.map((cost) => cost.id)).toEqual(["9007199254740993", "9007199254740994"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("pageSize=200");
    expect(calls[1]).toContain("cursor=cursor-2");
    expect(calls.some((url) => /\/projects\/|\/runs\//u.test(url))).toBe(false);
  });

  it("classifies network and auth failures without returning data", async () => {
    await expect(client(NETWORK_FAILURE).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "unavailable",
      reason: "network",
    });
    for (const status of [401, 403] as const) {
      const { fetchImpl } = fetchPages(json({ error: "denied" }, status));
      await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({ kind: "auth", status });
    }
  });

  it.each([201, 204, 404, 500, 503])("treats HTTP %i as upstream failure, never empty", async (status) => {
    const { fetchImpl } = fetchPages(new Response(status === 204 ? null : "{}", { status }));
    await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "unavailable",
      reason: "upstream",
      status,
    });
  });

  it("rejects invalid JSON", async () => {
    const { fetchImpl } = fetchPages(new Response("not-json", { status: 200 }));
    await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  it.each([
    ["extra response key", { orgId: "org_acme", costs: [], runs: [], nextCursor: null, extra: true }],
    ["wrong org", { orgId: "org_other", costs: [], runs: [], nextCursor: null }],
    ["malformed cost", { orgId: "org_acme", costs: [{ ...COST, costUsd: "free" }], runs: [RUN], nextCursor: null }],
    [
      "unknown basis with dollars",
      { orgId: "org_acme", costs: [{ ...COST, costBasis: "unknown" }], runs: [RUN], nextCursor: null },
    ],
    [
      "inconsistent token total",
      { orgId: "org_acme", costs: [{ ...COST, totalTokens: 99 }], runs: [RUN], nextCursor: null },
    ],
    ["extra run key", { orgId: "org_acme", costs: [COST], runs: [{ ...RUN, orgId: "org_acme" }], nextCursor: null }],
  ])("rejects %s in a successful-looking response", async (_label, body) => {
    const { fetchImpl } = fetchPages(json(body));
    await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  it("rejects duplicate identities across pages", async () => {
    const { fetchImpl } = fetchPages(
      json({ orgId: "org_acme", costs: [COST], runs: [RUN], nextCursor: "next" }),
      json({ orgId: "org_acme", costs: [COST], runs: [], nextCursor: null }),
    );
    await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  it("rejects non-progressing pagination", async () => {
    const { fetchImpl } = fetchPages(json({ orgId: "org_acme", costs: [], runs: [], nextCursor: "stuck" }));
    await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  it("rejects a repeated cursor after two nonempty, otherwise valid pages", async () => {
    const run2 = { ...RUN, runId: "run_2", projectId: "project_2", specId: "spec_2", specTitle: "Two" };
    const cost2 = { ...COST, id: "9007199254740994", runId: "run_2", projectId: "project_2" };
    const { fetchImpl, calls } = fetchPages(
      json({ orgId: "org_acme", costs: [COST], runs: [RUN], nextCursor: "stuck" }),
      json({ orgId: "org_acme", costs: [cost2], runs: [run2], nextCursor: "stuck" }),
    );

    await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("cursor=stuck");
  });

  it("binds every cost to a returned run and matching project", async () => {
    const { fetchImpl } = fetchPages(
      json({ orgId: "org_acme", costs: [{ ...COST, projectId: "project_wrong" }], runs: [RUN], nextCursor: null }),
    );
    await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  it("rejects rows that violate the contract's stable keyset ordering", async () => {
    const later = { ...COST, id: "9007199254740994", recordedAt: "2026-05-02T00:00:30.000Z" };
    const { fetchImpl } = fetchPages(json({ orgId: "org_acme", costs: [later, COST], runs: [RUN], nextCursor: null }));
    await expect(client(fetchImpl).getOrgCosts("org_acme")).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });
});
