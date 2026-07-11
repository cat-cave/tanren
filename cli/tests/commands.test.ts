import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MainModuleNs from "../src/main.js";
import { captureStdout } from "./helpers/captureOutput.js";
import { startStubServer, type StubServer } from "./helpers/stubServer.js";

// These tests drive the real CLI handlers end-to-end against a real local HTTP
// listener (the stub orchestrator), then assert on the OBSERVABLE outcome — the
// JSON the command prints — and on the request the server actually received
// (method / path / parsed body), by value. No `fetch` spy or `console.log`
// call-count assertions: see docs/contracts/architecture-checks.md
// (Behavior-based tests).

// `httpClient.ts` reads TANREN_PUBLIC_BASE_URL at module load, so the env must
// be set before the command module is imported. Each test imports the handlers
// fresh after the stub URL is known via `loadMain()`.
type MainModule = typeof MainModuleNs;

let server: StubServer;
let authDir = "";

async function loadMain(): Promise<MainModule> {
  // Re-import so the module-level `orchestratorUrl` is recomputed from the env
  // pointed at this test's freshly-listening stub server.
  vi.resetModules();
  return import("../src/main.js");
}

beforeEach(async () => {
  // Isolate from any developer auth file so no bearer header leaks into the
  // recorded requests (keeps the request-contract assertions hermetic).
  authDir = await mkdtemp(join(tmpdir(), "tanren-cli-auth-"));
  process.env.TANREN_AUTH_FILE = join(authDir, "missing-auth.json");
});

afterEach(async () => {
  await server?.close();
  await rm(authDir, { recursive: true, force: true });
  delete process.env.TANREN_PUBLIC_BASE_URL;
  delete process.env.TANREN_AUTH_FILE;
});

async function withStub(responseBody: unknown): Promise<MainModule> {
  server = await startStubServer(responseBody);
  process.env.TANREN_PUBLIC_BASE_URL = server.url;
  return loadMain();
}

describe("cli package", () => {
  it("has a test harness", () => {
    expect(process.version.startsWith("v")).toBe(true);
  });

  it("prints run status with ordered tasks", async () => {
    const runState = {
      run: { run_id: "run_1", status: "done" },
      tasks: [
        { task_id: "task_plan", kind: "plan", status: "done" },
        { task_id: "task_write", kind: "write", status: "done" },
      ],
      events: [],
      costs: [],
    };
    const { status } = await withStub(runState);

    const out = await captureStdout(() => status("run_1"));

    // Observable outcome: the command renders the run state it fetched.
    expect(out.json()).toEqual(runState);
    // Request contract: it read the run by id over GET.
    expect(server.lastRequest().method).toBe("GET");
    expect(server.lastRequest().path).toBe("/runs/run_1");
  });

  it("creates projects with parsed optional config", async () => {
    const created = {
      projectId: "project_1",
      name: "Tanren",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      defaultBranch: "main",
    };
    const { createProjectCommand } = await withStub(created);

    const out = await captureStdout(() =>
      createProjectCommand([
        "--name",
        "Tanren",
        "--repo-url",
        "https://github.com/cat-cave/tanren-fixture-easy",
        "--config-json",
        '{"budgetUsd":25}',
      ]),
    );

    expect(out.json()).toEqual(created);
    const sent = server.lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/projects");
    expect(sent.json).toMatchObject({
      name: "Tanren",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      config: { budgetUsd: 25 },
    });
  });

  it("project create rejects non-object and invalid --config-json before the network", async () => {
    const { createProjectCommand } = await withStub({ projectId: "project_1" });
    const base = ["--name", "Tanren", "--repo-url", "https://github.com/cat-cave/x"];
    await expect(createProjectCommand([...base, "--config-json", "[]"])).rejects.toThrow(/must be a JSON object/u);
    await expect(createProjectCommand([...base, "--config-json", "null"])).rejects.toThrow(/must be a JSON object/u);
    await expect(createProjectCommand([...base, "--config-json", '"string"'])).rejects.toThrow(
      /must be a JSON object/u,
    );
    await expect(createProjectCommand([...base, "--config-json", "not-json"])).rejects.toThrow(/not valid JSON/u);
    // Redaction: sentinel secret in truncated JSON must not appear in the error.
    const secret = "tnt_sentinel_SECRET_never_leak_9f3a";
    const error = await createProjectCommand([...base, "--config-json", `{"token":"${secret}"`]).then(
      () => {
        throw new Error("expected createProjectCommand to reject");
      },
      (e: unknown) => e,
    );
    expect((error as Error).message).toMatch(/not valid JSON/u);
    expect((error as Error).message).not.toContain(secret);
    expect(() => server.lastRequest()).toThrow(/no requests/u);
  });

  it("creates specs with repeated acceptance criteria and dependencies", async () => {
    const { createSpecCommand } = await withStub({ specId: "spec_1", projectId: "project_1" });

    const out = await captureStdout(() =>
      createSpecCommand([
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
        "spec_0",
      ]),
    );

    expect(out.json()).toEqual({ specId: "spec_1", projectId: "project_1" });
    const sent = server.lastRequest();
    expect(sent.path).toBe("/specs");
    expect(sent.json).toEqual({
      projectId: "project_1",
      title: "Add health check",
      description: "Add a health endpoint",
      acceptanceCriteria: ["GET /healthz returns ok", "Tests pass"],
      dependsOn: ["spec_0"],
    });
  });

  it("creates queued runs from a persisted spec", async () => {
    const queued = { runId: "run_1", specId: "spec_1", status: "queued" };
    const { runSpecCommand } = await withStub(queued);

    const out = await captureStdout(() => runSpecCommand(["--spec-id", "spec_1", "--branch", "tanren/custom"]));

    expect(out.json()).toEqual(queued);
    const sent = server.lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/specs/spec_1/runs");
    expect(sent.json).toEqual({ trigger: "cli", branch: "tanren/custom" });
  });

  it("requests draft PR creation for a run", async () => {
    const draftPr = { prUrl: "https://github.com/cat-cave/repo/pull/1" };
    const { createDraftPrCommand } = await withStub(draftPr);

    const out = await captureStdout(() =>
      createDraftPrCommand(["--run-id", "run_1", "--github-credential-ref", "credential/github/dev"]),
    );

    expect(out.json()).toEqual(draftPr);
    const sent = server.lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/runs/run_1/github/draft-pr");
    expect(sent.json).toMatchObject({ githubCredentialRef: "credential/github/dev" });
  });

  it("requests CI polling for a run", async () => {
    const ciStatus = { runId: "run_1", status: "pending", reason: "no_checks" };
    const { pollCiCommand } = await withStub(ciStatus);

    const out = await captureStdout(() =>
      pollCiCommand(["--run-id", "run_1", "--github-credential-ref", "credential/github/dev"]),
    );

    expect(out.json()).toEqual(ciStatus);
    const sent = server.lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/runs/run_1/ci/poll");
    expect(sent.json).toMatchObject({ githubCredentialRef: "credential/github/dev" });
  });
});
