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

describe("ForgeTurnStore.append atomicity (audit RC-4 #2): concurrent appends on ONE thread get distinct indices, no 500", () => {
  it("two concurrent appends on the same thread both succeed with distinct turn_index (one clean 23505 retry)", async () => {
    const client = new ForgeMemoryClient();
    // Open the snapshot window so the two appends genuinely race the same MAX+1: the
    // loser hits the (thread_id, turn_index) unique violation, which the single-statement
    // INSERT's bounded retry recovers from (re-derives MAX+1 on its own snapshot).
    client.yieldDuringTurnInsert = true;
    const thread = await ForgeThreadStore.create(
      pool(client),
      { orgId: "org_a", scope: "org", projectId: null, runId: null, title: null },
      orgAdmin,
    );

    const appendOne = (): Promise<{ index: number }> =>
      ForgeTurnStore.append(
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

    // Both run concurrently — neither 500s (no unhandled 23505 surfaces to the caller).
    const [a, b] = await Promise.all([appendOne(), appendOne()]);

    // Both committed, with DISTINCT indices (0 and 1) — the unique constraint held and
    // the retry assigned the loser the next free index instead of throwing.
    const indices = [a.index, b.index].sort((x, y) => x - y);
    expect(indices).toEqual([0, 1]);
    expect(client.turns).toHaveLength(2);
    expect(new Set(client.turns.map((t) => t.turn_index)).size).toBe(2);
  });
});

describe("ForgeTurnStore decode-at-the-boundary (audit RC-6)", () => {
  // Seed a thread the actor can reach, then plant a RAW turn row directly so the
  // read path's Zod decode (not the append validation) is what's under test.
  async function seedThread(client: ForgeMemoryClient): Promise<string> {
    const thread = await ForgeThreadStore.create(
      pool(client),
      { orgId: "org_a", scope: "project", projectId: "project_a", runId: null, title: null },
      orgAdmin,
    );
    return thread.id;
  }

  function plantTurn(client: ForgeMemoryClient, overrides: Record<string, unknown>): string {
    const id = `forge_turn_${client.turns.length}`;
    // Cast through the raw map — the point is to exercise decode on an arbitrary
    // row shape (a real pg row is an untrusted `unknown`).
    client.turns.push({
      id,
      thread_id: "thread_x",
      turn_index: 0,
      source: { kind: "operator", userId: "u" },
      audience: "project:member",
      author_kind: "forge_template",
      render: validRender,
      created_at: new Date("2026-02-02T00:00:00Z"),
      ...overrides,
    } as never);
    return id;
  }

  it("decodes a well-formed turn row to the typed shape (real Date, valid enums, parsed source)", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);
    // Plant a raw row whose source/render arrive as JSON STRINGS (the wire form a
    // jsonb column can take) to prove the decode parses them, not just passes objects.
    const id = plantTurn(client, {
      thread_id: threadId,
      source: JSON.stringify({ kind: "operator", userId: "u_42" }),
      render: JSON.stringify(validRender),
      audience: "org:admin",
      author_kind: "forge_llm",
      created_at: new Date("2026-03-03T04:05:06Z"),
    });
    const turn = await ForgeTurnStore.get(pool(client), id, orgAdmin);
    if (turn === undefined) throw new Error("expected a decoded turn");
    expect(turn.createdAt).toBeInstanceOf(Date);
    expect(turn.createdAt.toISOString()).toBe("2026-03-03T04:05:06.000Z");
    expect(turn.audience).toBe("org:admin");
    expect(turn.authorKind).toBe("forge_llm");
    expect(turn.source).toEqual({ kind: "operator", userId: "u_42" });
    expect((turn.render as { body: string }).body).toBe(validRender.body);
  });

  it("THROWS on a row with a bad `audience` enum value", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);
    const id = plantTurn(client, { thread_id: threadId, audience: "everyone" });
    await expect(ForgeTurnStore.get(pool(client), id, orgAdmin)).rejects.toThrow(/audience|Invalid/u);
  });

  it("THROWS on a row with an unparseable `source` JSON string", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);
    const id = plantTurn(client, { thread_id: threadId, source: "{not json" });
    await expect(ForgeTurnStore.get(pool(client), id, orgAdmin)).rejects.toThrow(/JSON|Unexpected|token/u);
  });

  it("THROWS on a row whose `source` JSON parses but is not a ForgeTurnSource", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);
    const id = plantTurn(client, { thread_id: threadId, source: JSON.stringify({ kind: "nope" }) });
    await expect(ForgeTurnStore.get(pool(client), id, orgAdmin)).rejects.toThrow(/kind|Invalid/u);
  });

  it("THROWS on a row with a non-coercible `created_at`", async () => {
    const client = new ForgeMemoryClient();
    const threadId = await seedThread(client);
    const id = plantTurn(client, { thread_id: threadId, created_at: "not-a-timestamp" });
    await expect(ForgeTurnStore.get(pool(client), id, orgAdmin)).rejects.toThrow(/date|Invalid/u);
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
