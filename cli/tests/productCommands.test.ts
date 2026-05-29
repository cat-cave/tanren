import { afterEach, describe, expect, it, vi } from "vitest";
import type * as CredentialsNs from "../src/commands/credentials/index.js";
import { findProductHandler, listProductCommands } from "../src/commands/dispatch.js";
import type * as MilestonesNs from "../src/commands/milestones/index.js";
import type * as OrgsNs from "../src/commands/orgs/index.js";
import type * as PersonasNs from "../src/commands/personas/index.js";
import type * as ProjectsNs from "../src/commands/projects/index.js";
import type * as SpecsNs from "../src/commands/specs/index.js";
import { captureStdout } from "./helpers/captureOutput.js";
import { startStubServer, type StubServer } from "./helpers/stubServer.js";

// P2A-0013 product CLI commands, driven end-to-end against a real local stub
// orchestrator. Each test asserts the OBSERVABLE outcome (the JSON the command
// prints) and pins the request contract by reading the request the server
// received — method, path, query, parsed body — by value. No `fetch` spying or
// `console.log` call-count assertions. See docs/contracts/architecture-checks.md
// (Behavior-based tests).

type CommandModules = {
  credentials: typeof CredentialsNs;
  milestones: typeof MilestonesNs;
  orgs: typeof OrgsNs;
  personas: typeof PersonasNs;
  projects: typeof ProjectsNs;
  specs: typeof SpecsNs;
};

let server: StubServer;

async function loadCommands(): Promise<CommandModules> {
  // Re-import so the httpClient's module-level orchestratorUrl is recomputed
  // from the env pointed at this test's freshly-listening stub server.
  vi.resetModules();
  return {
    credentials: await import("../src/commands/credentials/index.js"),
    milestones: await import("../src/commands/milestones/index.js"),
    orgs: await import("../src/commands/orgs/index.js"),
    personas: await import("../src/commands/personas/index.js"),
    projects: await import("../src/commands/projects/index.js"),
    specs: await import("../src/commands/specs/index.js"),
  };
}

async function withStub(responseBody: unknown): Promise<CommandModules> {
  server = await startStubServer(responseBody);
  process.env.TANREN_ORCHESTRATOR_URL = server.url;
  // Isolate from any developer auth file so no bearer header leaks in.
  process.env.TANREN_AUTH_FILE = "/nonexistent/tanren-product-cli-auth.json";
  return loadCommands();
}

afterEach(async () => {
  await server?.close();
  delete process.env.TANREN_ORCHESTRATOR_URL;
  delete process.env.TANREN_AUTH_FILE;
});

describe("P2A-0013 product CLI commands", () => {
  describe("dispatch table", () => {
    it("dispatches by `<command> <subcommand>` pair", () => {
      expect(findProductHandler("orgs", "list")).toBeDefined();
      expect(findProductHandler("projects", "create")).toBeDefined();
      expect(findProductHandler("specs", "run")).toBeDefined();
      expect(findProductHandler("unknown", "x")).toBeUndefined();
      expect(listProductCommands().length).toBeGreaterThan(10);
    });
  });

  it("orgs list calls GET /orgs and renders the result", async () => {
    const body = { orgs: [{ id: "org_acme" }] };
    const { orgs } = await withStub(body);
    const out = await captureStdout(() => orgs.orgsList([]));
    expect(out.json()).toEqual(body);
    expect(server.lastRequest().method).toBe("GET");
    expect(server.lastRequest().path).toBe("/orgs");
  });

  it("orgs get accepts a positional org id", async () => {
    const body = { id: "org_acme" };
    const { orgs } = await withStub(body);
    const out = await captureStdout(() => orgs.orgsGet(["org_acme"]));
    expect(out.json()).toEqual(body);
    expect(server.lastRequest().path).toBe("/orgs/org_acme");
  });

  it("orgs config-set issues a PATCH with parsed JSON body", async () => {
    const { orgs } = await withStub({ id: "org_acme" });
    const out = await captureStdout(() =>
      orgs.orgsConfigSet(["--org-id", "org_acme", "--config-json", '{"version":1}']),
    );
    expect(out.json()).toEqual({ id: "org_acme" });
    const sent = server.lastRequest();
    expect(sent.path).toBe("/orgs/org_acme");
    expect(sent.method).toBe("PATCH");
    expect(sent.json).toEqual({ config: { version: 1 } });
  });

  it("projects create POSTs to the org-scoped projects route", async () => {
    const body = { projectId: "project_1" };
    const { projects } = await withStub(body);
    const out = await captureStdout(() =>
      projects.projectsCreate([
        "--org-id",
        "org_acme",
        "--name",
        "Tanren",
        "--repo-url",
        "https://github.com/cat-cave/x",
      ]),
    );
    expect(out.json()).toEqual(body);
    const sent = server.lastRequest();
    expect(sent.path).toBe("/orgs/org_acme/projects");
    expect(sent.json).toMatchObject({ name: "Tanren" });
  });

  it("projects link posts the repo URL to the link endpoint", async () => {
    const body = { projectId: "project_1", writesPerformed: 0 };
    const { projects } = await withStub(body);
    const out = await captureStdout(() =>
      projects.projectsLink([
        "--org-id",
        "org_acme",
        "--project-id",
        "project_1",
        "--repo-url",
        "https://github.com/cat-cave/x",
      ]),
    );
    expect(out.json()).toEqual(body);
    const sent = server.lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/orgs/org_acme/projects/project_1/link");
    expect(sent.json).toMatchObject({ repoUrl: "https://github.com/cat-cave/x" });
  });

  it("specs create normalizes acceptance criteria into an array", async () => {
    const { specs } = await withStub({ specId: "spec_1" });
    const out = await captureStdout(() =>
      specs.specsCreate([
        "--org-id",
        "org_acme",
        "--project-id",
        "project_1",
        "--title",
        "T",
        "--description",
        "D",
        "--acceptance",
        "C1",
        "--acceptance",
        "C2",
      ]),
    );
    expect(out.json()).toEqual({ specId: "spec_1" });
    expect(server.lastRequest().json).toMatchObject({ acceptanceCriteria: ["C1", "C2"] });
  });

  it("specs run posts to the org+project+spec runs route", async () => {
    const body = { runId: "run_1" };
    const { specs } = await withStub(body);
    const out = await captureStdout(() =>
      specs.specsRun([
        "--org-id",
        "org_acme",
        "--project-id",
        "project_1",
        "--spec-id",
        "spec_1",
        "--branch",
        "tanren/foo",
      ]),
    );
    expect(out.json()).toEqual(body);
    const sent = server.lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/orgs/org_acme/projects/project_1/specs/spec_1/runs");
    expect(sent.json).toMatchObject({ branch: "tanren/foo" });
  });

  it("personas create defaults scope to org when no project provided", async () => {
    const { personas } = await withStub({ id: "persona_1" });
    const out = await captureStdout(() => personas.personasCreate(["--org-id", "org_acme", "--name", "Sales"]));
    expect(out.json()).toEqual({ id: "persona_1" });
    expect(server.lastRequest().json).toMatchObject({ scope: "org" });
  });

  it("milestones create parses order-index as a number", async () => {
    const { milestones } = await withStub({ id: "milestone_1" });
    const out = await captureStdout(() =>
      milestones.milestonesCreate([
        "--org-id",
        "org_acme",
        "--project-id",
        "project_1",
        "--label",
        "m1",
        "--name",
        "Milestone One",
        "--order-index",
        "3",
      ]),
    );
    expect(out.json()).toEqual({ id: "milestone_1" });
    expect(server.lastRequest().json).toMatchObject({ orderIndex: 3 });
  });

  it("credentials list defaults to /credentials/me without --org-id", async () => {
    const body = { credentials: [] };
    const { credentials } = await withStub(body);
    const out = await captureStdout(() => credentials.credentialsList([]));
    expect(out.json()).toEqual(body);
    expect(server.lastRequest().path).toBe("/credentials/me");
  });

  it("credentials create routes by --kind", async () => {
    const body = { ref: "credential/github_token/me/x", redacted: true };
    const { credentials } = await withStub(body);
    const out = await captureStdout(() =>
      credentials.credentialsCreate([
        "--ref",
        "credential/github_token/me/x",
        "--value",
        "ghp_xxx",
        "--kind",
        "github_token",
      ]),
    );
    expect(out.json()).toEqual(body);
    const sent = server.lastRequest();
    expect(sent.query.kind).toBe("github_token");
    expect(sent.json).toHaveProperty("token");
  });
});
