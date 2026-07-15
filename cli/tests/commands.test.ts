import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

let server: StubServer | undefined;
let authDir = "";

function stub(): StubServer {
  if (server === undefined) throw new Error("stub server is not active");
  return server;
}

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
  const current = server;
  server = undefined;
  await current?.close();
  await rm(authDir, { recursive: true, force: true });
  delete process.env.TANREN_PUBLIC_BASE_URL;
  delete process.env.TANREN_AUTH_FILE;
});

async function withStub(responseBody: unknown): Promise<MainModule> {
  server = await startStubServer(responseBody);
  process.env.TANREN_PUBLIC_BASE_URL = stub().url;
  return loadMain();
}

describe("cli package", () => {
  it("has a test harness", () => {
    expect(process.version.startsWith("v")).toBe(true);
  });

  it("prints run status with ordered tasks", async () => {
    const runState = {
      run: { run_id: "run_1", status: "completed" },
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
    expect(stub().lastRequest().method).toBe("GET");
    expect(stub().lastRequest().path).toBe("/runs/run_1");
  });

  it("rejects a wrong-run or malformed HTTP-200 status payload", async () => {
    let commands = await withStub({
      run: { run_id: "run_decoy", status: "completed" },
      tasks: [],
      events: [],
      costs: [],
    });
    await expect(commands.status("run_1")).rejects.toThrow(/expected run run_1/u);
    await stub().close();

    commands = await withStub({ run: { run_id: "run_1", status: "completed" }, tasks: "not-an-array" });
    await expect(commands.status("run_1")).rejects.toThrow(/response\.tasks must be an array/u);
  });

  it("doctor succeeds only for a semantically healthy orchestrator", async () => {
    const healthy = { service: "orchestrator", ok: true, database: "ok", vault: { ok: true } };
    const { doctor } = await withStub(healthy);
    const out = await captureStdout(doctor);
    expect(out.json()).toEqual(healthy);
    expect(stub().lastRequest().path).toBe("/healthz");
  });

  it("doctor fails closed when health returns HTTP 200 with ok=false", async () => {
    const unhealthy = { service: "orchestrator", ok: false, database: "ok", vault: { ok: false } };
    const { doctor } = await withStub(unhealthy);
    await expect(doctor()).rejects.toThrow(/orchestrator is not healthy/u);
  });

  it("does not follow an orchestrator redirect to a healthy decoy", async () => {
    let decoyRequests = 0;
    const decoy = createServer((_request, response) => {
      decoyRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, database: "ok", vault: { ok: true } }));
    });
    await new Promise<void>((resolve) => {
      decoy.listen(0, "127.0.0.1", resolve);
    });
    const decoyPort = (decoy.address() as AddressInfo).port;
    const candidate = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${decoyPort}/healthz` });
      response.end();
    });
    await new Promise<void>((resolve) => {
      candidate.listen(0, "127.0.0.1", resolve);
    });
    try {
      process.env.TANREN_PUBLIC_BASE_URL = `http://127.0.0.1:${(candidate.address() as AddressInfo).port}`;
      const { doctor: redirectedDoctor } = await loadMain();
      await expect(redirectedDoctor()).rejects.toThrow(/fetch failed|redirect/u);
      expect(decoyRequests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => {
          candidate.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          decoy.close(() => resolve());
        }),
      ]);
    }
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
    const sent = stub().lastRequest();
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
    expect(() => stub().lastRequest()).toThrow(/no requests/u);
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
    const sent = stub().lastRequest();
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
    const sent = stub().lastRequest();
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
    const sent = stub().lastRequest();
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
    const sent = stub().lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/runs/run_1/ci/poll");
    expect(sent.json).toMatchObject({ githubCredentialRef: "credential/github/dev" });
  });
});
