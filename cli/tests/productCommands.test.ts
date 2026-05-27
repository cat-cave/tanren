import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialsCreate, credentialsList } from "../src/commands/credentials/index.js";
import { findProductHandler, listProductCommands } from "../src/commands/dispatch.js";
import { milestonesCreate } from "../src/commands/milestones/index.js";
import { orgsConfigSet, orgsGet, orgsList } from "../src/commands/orgs/index.js";
import { personasCreate } from "../src/commands/personas/index.js";
import { projectsCreate, projectsLink } from "../src/commands/projects/index.js";
import { specsCreate, specsRun } from "../src/commands/specs/index.js";

function stubJsonFetch(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (_url, _init) => new Response(JSON.stringify(body), { status: 200 })
  );
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return fetch;
}

describe("P2A-0013 product CLI commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dispatches by `<command> <subcommand>` pair", () => {
    expect(findProductHandler("orgs", "list")).toBeDefined();
    expect(findProductHandler("projects", "create")).toBeDefined();
    expect(findProductHandler("specs", "run")).toBeDefined();
    expect(findProductHandler("unknown", "x")).toBeUndefined();
    expect(listProductCommands().length).toBeGreaterThan(10);
  });

  it("orgs list calls GET /orgs", async () => {
    const fetch = stubJsonFetch({ orgs: [] });
    await orgsList([]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:3100/orgs", expect.objectContaining({}));
  });

  it("orgs get accepts --org-id or positional", async () => {
    const fetch = stubJsonFetch({ id: "org_acme" });
    await orgsGet(["org_acme"]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:3100/orgs/org_acme", expect.objectContaining({}));
  });

  it("orgs config-set issues a PATCH with parsed JSON body", async () => {
    const fetch = stubJsonFetch({ id: "org_acme" });
    await orgsConfigSet(["--org-id", "org_acme", "--config-json", '{"version":1}']);
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3100/orgs/org_acme");
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ config: { version: 1 } });
  });

  it("projects create POSTs to the org-scoped projects route", async () => {
    const fetch = stubJsonFetch({ projectId: "project_1" });
    await projectsCreate([
      "--org-id",
      "org_acme",
      "--name",
      "Tanren",
      "--repo-url",
      "https://github.com/cat-cave/x"
    ]);
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3100/orgs/org_acme/projects");
    expect(JSON.parse(String((call?.[1] as RequestInit)?.body))).toMatchObject({ name: "Tanren" });
  });

  it("projects link posts the repo URL to the link endpoint", async () => {
    const fetch = stubJsonFetch({ projectId: "project_1", writesPerformed: 0 });
    await projectsLink([
      "--org-id",
      "org_acme",
      "--project-id",
      "project_1",
      "--repo-url",
      "https://github.com/cat-cave/x"
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3100/orgs/org_acme/projects/project_1/link",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("specs create normalizes acceptance criteria into an array", async () => {
    const fetch = stubJsonFetch({ specId: "spec_1" });
    await specsCreate([
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
      "C2"
    ]);
    const body = JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit)?.body));
    expect(body).toMatchObject({ acceptanceCriteria: ["C1", "C2"] });
  });

  it("specs run posts to the org+project+spec runs route", async () => {
    const fetch = stubJsonFetch({ runId: "run_1" });
    await specsRun([
      "--org-id",
      "org_acme",
      "--project-id",
      "project_1",
      "--spec-id",
      "spec_1",
      "--branch",
      "tanren/foo"
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3100/orgs/org_acme/projects/project_1/specs/spec_1/runs",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("personas create defaults scope to org when no project provided", async () => {
    const fetch = stubJsonFetch({ id: "persona_1" });
    await personasCreate(["--org-id", "org_acme", "--name", "Sales"]);
    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit)?.body))).toMatchObject({ scope: "org" });
  });

  it("milestones create parses order-index as a number", async () => {
    const fetch = stubJsonFetch({ id: "milestone_1" });
    await milestonesCreate([
      "--org-id",
      "org_acme",
      "--project-id",
      "project_1",
      "--label",
      "m1",
      "--name",
      "Milestone One",
      "--order-index",
      "3"
    ]);
    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit)?.body))).toMatchObject({ orderIndex: 3 });
  });

  it("credentials list defaults to /credentials/me without --org-id", async () => {
    const fetch = stubJsonFetch({ credentials: [] });
    await credentialsList([]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:3100/credentials/me", expect.objectContaining({}));
  });

  it("credentials create routes by --kind", async () => {
    const fetch = stubJsonFetch({ ref: "credential/github_token/me/x", redacted: true });
    await credentialsCreate(["--ref", "credential/github_token/me/x", "--value", "ghp_xxx", "--kind", "github_token"]);
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toContain("kind=github_token");
    const body = JSON.parse(String((call?.[1] as RequestInit)?.body));
    expect(body).toHaveProperty("token");
  });
});
