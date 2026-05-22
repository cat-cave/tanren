import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectCommand, createSpecCommand, runSpecCommand, status } from "../src/main.js";

describe("cli package", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("has a test harness", () => {
    expect(process.version.startsWith("v")).toBe(true);
  });

  it("prints run status with ordered tasks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            run: { run_id: "run_1", status: "done" },
            tasks: [
              { task_id: "task_plan", kind: "plan", status: "done" },
              { task_id: "task_write", kind: "write", status: "done" }
            ],
            events: [],
            costs: []
          }),
          { status: 200 }
        );
      })
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await status("run_1");

    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          run: { run_id: "run_1", status: "done" },
          tasks: [
            { task_id: "task_plan", kind: "plan", status: "done" },
            { task_id: "task_write", kind: "write", status: "done" }
          ],
          events: [],
          costs: []
        },
        null,
        2
      )
    );
  });

  it("creates projects with parsed optional config", async () => {
    const fetch = stubJsonFetch({
      projectId: "project_1",
      name: "Tanren",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      defaultBranch: "main"
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProjectCommand([
      "--name",
      "Tanren",
      "--repo-url",
      "https://github.com/cat-cave/tanren-fixture-easy",
      "--config-json",
      '{"budgetUsd":25}'
    ]);

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3100/projects",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Tanren",
          repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
          config: { budgetUsd: 25 }
        })
      })
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"projectId": "project_1"'));
  });

  it("creates specs with repeated acceptance criteria and dependencies", async () => {
    const fetch = stubJsonFetch({ specId: "spec_1", projectId: "project_1" });

    await createSpecCommand([
      "--project-id",
      "project_1",
      "--title",
      "Add health check",
      "--description",
      "Add a health endpoint",
      "--acceptance",
      "GET /healthz returns ok",
      "--acceptance",
      "Tests pass",
      "--depends-on",
      "spec_0"
    ]);

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      projectId: "project_1",
      title: "Add health check",
      description: "Add a health endpoint",
      acceptanceCriteria: ["GET /healthz returns ok", "Tests pass"],
      dependsOn: ["spec_0"]
    });
  });

  it("creates queued runs from a persisted spec", async () => {
    const fetch = stubJsonFetch({ runId: "run_1", specId: "spec_1", status: "queued" });

    await runSpecCommand(["--spec-id", "spec_1", "--branch", "tanren/custom"]);

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3100/specs/spec_1/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ trigger: "cli", branch: "tanren/custom" })
      })
    );
  });
});

function stubJsonFetch(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 })
  );
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return fetch;
}
