import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const RUN = "run_1";
const ORG = "org_1";
const PROJECT = "project_1";
const PATH = `/runs/${RUN}/stream?orgId=${ORG}&projectId=${PROJECT}`;
const SSE = "id: 1\nretry: 1000\nevent: snapshot\ndata: {}\n\n";

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
});
afterEach(() => vi.unstubAllGlobals());

describe("run-detail SSE proxy identity and outage semantics", () => {
  it("uses the SSR-provided location directly and preserves protocol headers/body", async () => {
    const calls: Array<{ url: string; lastEventId: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: input.toString(),
        lastEventId: new Headers(init?.headers).get("last-event-id"),
      });
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    });
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const response = await app.request(PATH, { headers: { "last-event-id": "17" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SSE);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(calls).toEqual([
      {
        url: `http://localhost:3100/orgs/${ORG}/projects/${PROJECT}/runs/${RUN}/stream`,
        lastEventId: "17",
      },
    ]);
  });

  it("makes network and upstream-server outages retryable instead of not-found", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection reset");
    });
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const network = await app.request(PATH);
    expect(network.status).toBe(503);
    expect(network.headers.get("retry-after")).toBe("1");
    expect(await network.text()).toContain("temporarily unavailable");

    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    const server = await app.request(PATH);
    expect(server.status).toBe(500);
    expect(server.headers.get("retry-after")).toBe("1");
  });

  it.each([
    [401, "authentication"],
    [403, "forbidden"],
    [404, "not found"],
  ])("preserves upstream %i as a distinct non-outage result", async (status, text) => {
    vi.stubGlobal("fetch", async () => new Response("upstream", { status }));
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const response = await app.request(PATH);
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(text);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("rejects an unbound proxy request before any upstream scan", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    expect((await app.request(`/runs/${RUN}/stream`)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
