// Strict exact-200 + Zod decode proofs for listRunsMaybe / getRunDetail.

import { describe, expect, it } from "vitest";
import { OrchestratorClient } from "../src/api/orchestrator.js";
import { readRunDetail, readRunList } from "../src/api/runReads.js";

type FetchImpl = typeof fetch;

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

const DETAIL = {
  run: {
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
  },
  spec: {
    specId: "spec_1",
    title: "One",
    description: "desc",
    behaviorIds: ["b1"],
    milestoneId: null,
  },
  tasks: [],
  recentEvents: [],
  costs: [COST],
  insights: [],
  forgeThread: null,
} as const;

function deps(fetchImpl: FetchImpl) {
  return { orchestratorUrl: "http://orch", headers: { Accept: "application/json" }, fetchImpl };
}

function client(fetchImpl: FetchImpl): OrchestratorClient {
  return new OrchestratorClient({ orchestratorUrl: "http://orch", cookieHeader: "tanren_session=x", fetchImpl });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("readRunList / listRunsMaybe strict decode", () => {
  it("accepts exact 200 with empty items as genuine empty", async () => {
    const result = await readRunList(
      deps(async () => json({ items: [] })),
      "org_acme",
      "project_1",
    );
    expect(result).toEqual({ kind: "ok", items: [] });
    await expect(client(async () => json({ items: [] })).listRunsMaybe("org_acme", "project_1")).resolves.toEqual([]);
  });

  it("rejects 201/202/204 and other non-200 as unavailable (not empty)", async () => {
    for (const status of [201, 202, 204, 500, 503]) {
      const result = await readRunList(
        deps(async () => json({ items: [] }, status)),
        "org_acme",
        "project_1",
      );
      expect(result.kind).toBe("unavailable");
      await expect(
        client(async () => json({ items: [] }, status)).listRunsMaybe("org_acme", "project_1"),
      ).resolves.toBeUndefined();
    }
  });

  it("rejects malformed JSON, missing/extra fields, invalid enum/date/token/bucket", async () => {
    const cases: Array<{ body: unknown } | { text: string }> = [
      { text: "not-json" },
      { body: {} },
      { body: { items: [{ ...RUN, status: "bogus" }] } },
      { body: { items: [{ ...RUN, startedAt: "not-a-date" }] } },
      { body: { items: [{ ...RUN, extraField: true }] } },
      { body: { items: [{ ...RUN, runId: undefined }] } },
      { body: { items: [{ ...RUN, projectId: "other_project" }] } },
    ];
    for (const c of cases) {
      const fetchImpl: FetchImpl = async () => {
        if ("text" in c) return new Response(c.text, { status: 200 });
        return json(c.body);
      };
      const result = await readRunList(deps(fetchImpl), "org_acme", "project_1");
      expect(result.kind).toBe("unavailable");
    }
  });

  it("rejects project/run/spec binding mismatch on filtered list", async () => {
    const result = await readRunList(
      deps(async () => json({ items: [{ ...RUN, specId: "other_spec" }] })),
      "org_acme",
      "project_1",
      { specId: "spec_1" },
    );
    expect(result.kind).toBe("unavailable");
  });

  it("network throw is unavailable", async () => {
    const result = await readRunList(
      deps(async () => {
        throw new Error("offline");
      }),
      "org_acme",
      "project_1",
    );
    expect(result).toEqual({ kind: "unavailable", reason: "network" });
  });
});

describe("readRunDetail / getRunDetail strict decode", () => {
  it("accepts exact 200 full envelope", async () => {
    const result = await readRunDetail(
      deps(async () => json(DETAIL)),
      { orgId: "org_acme", projectId: "project_1" },
      "run_1",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.detail.run.runId).toBe("run_1");
    expect(String(result.detail.costs[0]?.id)).toBe("9007199254740993");
  });

  it("rejects non-200 including other 2xx", async () => {
    for (const status of [201, 204, 404, 500]) {
      const result = await readRunDetail(
        deps(async () => json(DETAIL, status)),
        { orgId: "org_acme", projectId: "project_1" },
        "run_1",
      );
      expect(result.kind).toBe("unavailable");
      await expect(
        client(async () => json(DETAIL, status)).getRunDetail({ orgId: "org_acme", projectId: "project_1" }, "run_1"),
      ).resolves.toBeUndefined();
    }
  });

  it("rejects malformed schema, invalid enum, token bucket mismatch, domain binding", async () => {
    const badBuckets = {
      ...DETAIL,
      costs: [{ ...COST, totalTokens: 99 }],
    };
    const wrongProject = {
      ...DETAIL,
      run: { ...DETAIL.run, projectId: "other" },
    };
    const wrongSpec = {
      ...DETAIL,
      spec: { ...DETAIL.spec, specId: "other" },
    };
    const extra = { ...DETAIL, unexpected: true };
    for (const body of [badBuckets, wrongProject, wrongSpec, extra, { run: DETAIL.run }]) {
      const result = await readRunDetail(
        deps(async () => json(body)),
        { orgId: "org_acme", projectId: "project_1" },
        "run_1",
      );
      expect(result.kind).toBe("unavailable");
    }
  });
});
