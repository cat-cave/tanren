// thread/turn append/read + audience scope tests.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { actorCanViewAudience, ForgeThreadStore, ForgeTurnStore } from "../src/engine/forge/index.js";
import { ForgeMemoryClient } from "./helpers/forgeMemoryClient.js";

const orgAdmin: ActorContext = {
  userId: "user_admin",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:admin", "org:member"],
  source: "session",
};

const orgMember: ActorContext = {
  userId: "user_member",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

const platformAdmin: ActorContext = {
  userId: "user_root",
  orgId: null,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const projectMember: ActorContext = {
  userId: "user_proj",
  orgId: null,
  projectId: "project_a",
  scopes: ["project:member"],
  source: "session",
};

function pool(client: ForgeMemoryClient): pg.Pool {
  return client as unknown as pg.Pool;
}

const validRender = {
  body: "Project pulse: 1 run in flight; $0 spent this week.",
  attentionItems: [],
  insights: [],
  prompts: ["What's next?"],
};

describe("ForgeThreadStore", () => {
  it("creates an org-scoped thread", async () => {
    const client = new ForgeMemoryClient();
    const thread = await ForgeThreadStore.create(
      pool(client),
      { orgId: "org_a", scope: "org", projectId: null, runId: null, title: null },
      orgAdmin,
    );
    expect(thread.id).toMatch(/^forge_thread_/u);
    expect(thread.scope).toBe("org");
    expect(thread.projectId).toBeNull();
  });

  it("rejects a project-scoped thread with missing projectId", async () => {
    const client = new ForgeMemoryClient();
    await expect(
      ForgeThreadStore.create(
        pool(client),
        { orgId: "org_a", scope: "project", projectId: null, runId: null, title: null },
        orgAdmin,
      ),
    ).rejects.toThrow(/projectId/u);
  });

  it("rejects a run-scoped thread missing runId", async () => {
    const client = new ForgeMemoryClient();
    await expect(
      ForgeThreadStore.create(
        pool(client),
        { orgId: "org_a", scope: "run", projectId: "project_a", runId: null, title: null },
        orgAdmin,
      ),
    ).rejects.toThrow(/runId/u);
  });

  it("rejects creating a thread for an org the actor cannot reach", async () => {
    const client = new ForgeMemoryClient();
    const stranger: ActorContext = {
      userId: "user_stranger",
      orgId: "org_b",
      projectId: null,
      scopes: ["org:member"],
      source: "session",
    };
    await expect(
      ForgeThreadStore.create(
        pool(client),
        { orgId: "org_a", scope: "org", projectId: null, runId: null, title: null },
        stranger,
      ),
    ).rejects.toThrow(/cannot reach/u);
  });

  it("platform:admin can create threads in any org", async () => {
    const client = new ForgeMemoryClient();
    const thread = await ForgeThreadStore.create(
      pool(client),
      { orgId: "org_a", scope: "project", projectId: "project_a", runId: null, title: null },
      platformAdmin,
    );
    expect(thread.scope).toBe("project");
    expect(thread.projectId).toBe("project_a");
  });
});

describe("ForgeTurnStore", () => {
  it("appends turns with monotonically increasing indices and validates render", async () => {
    const client = new ForgeMemoryClient();
    const thread = await ForgeThreadStore.create(
      pool(client),
      { orgId: "org_a", scope: "project", projectId: "project_a", runId: null, title: null },
      orgAdmin,
    );
    const first = await ForgeTurnStore.append(
      pool(client),
      {
        threadId: thread.id,
        source: { kind: "operator", userId: orgAdmin.userId },
        audience: "project:member",
        authorKind: "forge_template",
        render: validRender,
      },
      orgAdmin,
    );
    const second = await ForgeTurnStore.append(
      pool(client),
      {
        threadId: thread.id,
        source: { kind: "prior_turn", priorTurnId: first.id },
        audience: "project:member",
        authorKind: "forge_template",
        render: validRender,
      },
      orgAdmin,
    );
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
  });

  it("rejects a turn whose render does not match ForgeAnswer", async () => {
    const client = new ForgeMemoryClient();
    const thread = await ForgeThreadStore.create(
      pool(client),
      { orgId: "org_a", scope: "project", projectId: "project_a", runId: null, title: null },
      orgAdmin,
    );
    await expect(
      ForgeTurnStore.append(
        pool(client),
        {
          threadId: thread.id,
          source: { kind: "operator", userId: orgAdmin.userId },
          audience: "project:member",
          authorKind: "forge_template",
          // Missing required `body` — should fail the ForgeAnswer parse.
          render: {
            attentionItems: [],
            insights: [],
            prompts: [],
          } as unknown as typeof validRender,
        },
        orgAdmin,
      ),
    ).rejects.toThrow(/body/u);
  });

  it("filters turns the actor's scope cannot view", async () => {
    const client = new ForgeMemoryClient();
    const thread = await ForgeThreadStore.create(
      pool(client),
      { orgId: "org_a", scope: "project", projectId: "project_a", runId: null, title: null },
      orgAdmin,
    );
    await ForgeTurnStore.append(
      pool(client),
      {
        threadId: thread.id,
        source: { kind: "operator", userId: orgAdmin.userId },
        audience: "project:member",
        authorKind: "forge_template",
        render: validRender,
      },
      orgAdmin,
    );
    await ForgeTurnStore.append(
      pool(client),
      {
        threadId: thread.id,
        source: { kind: "operator", userId: orgAdmin.userId },
        audience: "org:admin",
        authorKind: "forge_template",
        render: validRender,
      },
      orgAdmin,
    );
    const memberTurns = await ForgeTurnStore.list(pool(client), { threadId: thread.id }, orgMember);
    expect(memberTurns).toHaveLength(1);
    expect(memberTurns[0]?.audience).toBe("project:member");
    const adminTurns = await ForgeTurnStore.list(pool(client), { threadId: thread.id }, orgAdmin);
    expect(adminTurns).toHaveLength(2);
  });
});

describe("actorCanViewAudience", () => {
  it("ranks audiences from project:member up to platform:admin", () => {
    const member: ActorContext = {
      userId: "u_m",
      orgId: null,
      projectId: "project_a",
      scopes: ["project:member"],
      source: "session",
    };
    expect(actorCanViewAudience(member, "project:member")).toBe(true);
    expect(actorCanViewAudience(member, "project:admin")).toBe(false);
    expect(actorCanViewAudience(member, "org:admin")).toBe(false);
    expect(actorCanViewAudience(orgAdmin, "org:admin")).toBe(true);
    expect(actorCanViewAudience(orgAdmin, "platform:admin")).toBe(false);
    expect(actorCanViewAudience(platformAdmin, "platform:admin")).toBe(true);
  });

  it("a project-only member can see project:member turns", () => {
    expect(actorCanViewAudience(projectMember, "project:member")).toBe(true);
    expect(actorCanViewAudience(projectMember, "org:admin")).toBe(false);
  });
});
