import { describe, expect, it, vi } from "vitest";
import { fetchRunDetail } from "../src/api/runDetailClient.js";
import { RUN_DETAIL, RUN_ID } from "./runDetail.render.fixtures.js";

const location = { orgId: "org_acme", projectId: RUN_DETAIL.run.projectId };

function deps(fetchImpl: typeof fetch) {
  return {
    orchestratorUrl: "http://orchestrator.test",
    headers: { cookie: "tanren_session=session" },
    fetchImpl,
  };
}

describe("strict run-detail HTTP boundary", () => {
  it("returns a decoded detail and forwards the audited raw-view opt-in", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(RUN_DETAIL), { status: 200 }));
    const result = await fetchRunDetail(deps(fetchImpl), location, RUN_ID, { rawView: true });
    expect(result).toEqual({ kind: "found", detail: RUN_DETAIL });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining(`${RUN_ID}?raw=true`), {
      headers: { cookie: "tanren_session=session", "x-view-raw": "true" },
    });
  });

  it.each([
    ["empty", undefined],
    ["malformed", { ...RUN_DETAIL, tasks: [{ taskId: "partial" }] }],
    ["wrong run", { ...RUN_DETAIL, run: { ...RUN_DETAIL.run, runId: "run_other" } }],
    ["wrong project", { ...RUN_DETAIL, run: { ...RUN_DETAIL.run, projectId: "project_other" } }],
  ])("classifies an %s 200 body as unavailable", async (_name, body) => {
    const responseBody = body === undefined ? "" : JSON.stringify(body);
    const result = await fetchRunDetail(
      deps(async () => new Response(responseBody, { status: 200 })),
      location,
      RUN_ID,
    );
    expect(result).toEqual({ kind: "unavailable", status: 200 });
  });

  it("distinguishes the exact not-found contract from every other 404", async () => {
    const exact = await fetchRunDetail(
      deps(async () => new Response(JSON.stringify({ error: "run_not_found" }), { status: 404 })),
      location,
      RUN_ID,
    );
    const malformed = await fetchRunDetail(
      deps(async () => new Response(JSON.stringify({ error: "run_not_found", message: "legacy" }), { status: 404 })),
      location,
      RUN_ID,
    );
    expect(exact).toEqual({ kind: "not_found" });
    expect(malformed).toEqual({ kind: "unavailable", status: 404 });
  });

  it("classifies transport and non-JSON failures as unavailable", async () => {
    const transport = await fetchRunDetail(
      deps(async () => {
        throw new Error("offline");
      }),
      location,
      RUN_ID,
    );
    const upstream = await fetchRunDetail(
      deps(async () => new Response("not json", { status: 503 })),
      location,
      RUN_ID,
    );
    expect(transport).toEqual({ kind: "unavailable", status: 0 });
    expect(upstream).toEqual({ kind: "unavailable", status: 503 });
  });
});
