import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  BehaviorStore,
  MilestoneStore,
  PersonaStore
} from "../src/engine/entities/index.js";
import { EntityMemoryClient } from "./helpers/entityMemoryClient.js";

const orgAdmin: ActorContext = {
  userId: "user_a",
  orgId: "org_1",
  projectId: null,
  scopes: ["org:admin", "org:member"],
  source: "session"
};

const platformAdmin: ActorContext = {
  userId: "user_admin",
  orgId: null,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session"
};

const projectOnlyMember: ActorContext = {
  userId: "user_p",
  orgId: null,
  projectId: "project_1",
  scopes: ["project:member"],
  source: "session"
};

describe("PersonaStore", () => {
  it("creates and reads an org-scoped persona", async () => {
    const client = new EntityMemoryClient();
    const persona = await PersonaStore.create(
      client,
      { scope: "org", orgId: "org_1", projectId: null, name: "Sales Manager", description: "regional ops lead" },
      orgAdmin
    );
    expect(persona.scope).toBe("org");
    expect(persona.projectId).toBeNull();
    const round = await PersonaStore.get(client, persona.id, orgAdmin);
    expect(round?.name).toBe("Sales Manager");
  });

  it("rejects an org-scoped persona with a non-null projectId at create time", async () => {
    const client = new EntityMemoryClient();
    await expect(
      PersonaStore.create(
        client,
        { scope: "org", orgId: "org_1", projectId: "project_1", name: "X", description: "" },
        orgAdmin
      )
    ).rejects.toThrow(/projectId/);
  });

  it("rejects a project-scoped persona with a null projectId at create time", async () => {
    const client = new EntityMemoryClient();
    await expect(
      PersonaStore.create(
        client,
        { scope: "project", orgId: "org_1", projectId: null, name: "X", description: "" },
        orgAdmin
      )
    ).rejects.toThrow(/projectId/);
  });

  it("lists org-scoped personas alongside project-scoped personas for a project", async () => {
    const client = new EntityMemoryClient();
    await PersonaStore.create(
      client,
      { scope: "org", orgId: "org_1", projectId: null, name: "Org Persona", description: "" },
      orgAdmin
    );
    await PersonaStore.create(
      client,
      { scope: "project", orgId: "org_1", projectId: "project_1", name: "Project Persona", description: "" },
      orgAdmin
    );
    await PersonaStore.create(
      client,
      { scope: "project", orgId: "org_1", projectId: "project_2", name: "Other Project Persona", description: "" },
      orgAdmin
    );
    const list = await PersonaStore.listForProject(client, { orgId: "org_1", projectId: "project_1" }, orgAdmin);
    const names = list.map((p) => p.name).sort();
    expect(names).toEqual(["Org Persona", "Project Persona"]);
  });

  it("denies an actor that is not a member of the org", async () => {
    const client = new EntityMemoryClient();
    const otherOrg: ActorContext = {
      userId: "user_other",
      orgId: "org_other",
      projectId: null,
      scopes: ["org:member"],
      source: "session"
    };
    await expect(
      PersonaStore.create(
        client,
        { scope: "org", orgId: "org_1", projectId: null, name: "X", description: "" },
        otherOrg
      )
    ).rejects.toThrow(/not scoped to org/);
  });

  it("allows a platform admin to bypass org scoping", async () => {
    const client = new EntityMemoryClient();
    const persona = await PersonaStore.create(
      client,
      { scope: "org", orgId: "org_1", projectId: null, name: "Admin Persona", description: "" },
      platformAdmin
    );
    expect(persona.name).toBe("Admin Persona");
  });
});

describe("BehaviorStore", () => {
  it("creates a behavior owned by a persona and reads it back", async () => {
    const client = new EntityMemoryClient();
    const persona = await PersonaStore.create(
      client,
      { scope: "org", orgId: "org_1", projectId: null, name: "Dev", description: "" },
      orgAdmin
    );
    /* eslint-disable unicorn/no-thenable */
    const behavior = await BehaviorStore.create(
      client,
      {
        personaId: persona.id,
        title: "export stats data as csv",
        given: "operator on dashboard",
        when: "they click export",
        then: "a csv file downloads"
      },
      orgAdmin
    );
    /* eslint-enable unicorn/no-thenable */
    expect(behavior.title).toBe("export stats data as csv");
    expect(behavior.description).toBeNull();
    const round = await BehaviorStore.get(client, behavior.id, orgAdmin);
    expect(round?.given).toBe("operator on dashboard");
  });

  it("links and lists behaviors for a spec", async () => {
    const client = new EntityMemoryClient();
    const persona = await PersonaStore.create(
      client,
      { scope: "org", orgId: "org_1", projectId: null, name: "Dev", description: "" },
      orgAdmin
    );
    /* eslint-disable unicorn/no-thenable */
    const behavior = await BehaviorStore.create(
      client,
      { personaId: persona.id, title: "b1", given: "g", when: "w", then: "t" },
      orgAdmin
    );
    /* eslint-enable unicorn/no-thenable */
    await BehaviorStore.linkToSpec(client, { specId: "spec_1", behaviorId: behavior.id }, orgAdmin);
    const list = await BehaviorStore.listForSpec(client, "spec_1", orgAdmin);
    expect(list.map((b) => b.id)).toEqual([behavior.id]);
  });
});

describe("MilestoneStore", () => {
  it("creates and reads a milestone", async () => {
    const client = new EntityMemoryClient();
    const m = await MilestoneStore.create(
      client,
      { projectId: "project_1", label: "M1", name: "Hello", orderIndex: 0 },
      orgAdmin
    );
    expect(m.status).toBe("planned");
    expect(m.eta).toBeNull();
    const round = await MilestoneStore.get(client, m.id, orgAdmin);
    expect(round?.label).toBe("M1");
  });

  it("rejects duplicate label in the same project", async () => {
    const client = new EntityMemoryClient();
    await MilestoneStore.create(
      client,
      { projectId: "project_1", label: "M1", name: "Hello", orderIndex: 0 },
      orgAdmin
    );
    await expect(
      MilestoneStore.create(
        client,
        { projectId: "project_1", label: "M1", name: "Duplicate", orderIndex: 1 },
        orgAdmin
      )
    ).rejects.toThrow(/duplicate milestone label/);
  });

  it("rejects duplicate order_index in the same project", async () => {
    const client = new EntityMemoryClient();
    await MilestoneStore.create(
      client,
      { projectId: "project_1", label: "M1", name: "Hello", orderIndex: 0 },
      orgAdmin
    );
    await expect(
      MilestoneStore.create(
        client,
        { projectId: "project_1", label: "M2", name: "Two", orderIndex: 0 },
        orgAdmin
      )
    ).rejects.toThrow(/order_index/);
  });

  it("setSpecMilestone enforces one-milestone-per-spec by replacing prior assignment", async () => {
    const client = new EntityMemoryClient();
    const m1 = await MilestoneStore.create(
      client,
      { projectId: "project_1", label: "M1", name: "Hello", orderIndex: 0 },
      orgAdmin
    );
    const m2 = await MilestoneStore.create(
      client,
      { projectId: "project_1", label: "M2", name: "Two", orderIndex: 1 },
      orgAdmin
    );
    await MilestoneStore.setSpecMilestone(client, { specId: "spec_1", milestoneId: m1.id }, orgAdmin);
    expect((await MilestoneStore.getSpecMilestone(client, "spec_1", orgAdmin))?.id).toBe(m1.id);
    await MilestoneStore.setSpecMilestone(client, { specId: "spec_1", milestoneId: m2.id }, orgAdmin);
    expect((await MilestoneStore.getSpecMilestone(client, "spec_1", orgAdmin))?.id).toBe(m2.id);
  });

  it("permits a project-only member to reach the project", async () => {
    const client = new EntityMemoryClient();
    await MilestoneStore.create(
      client,
      { projectId: "project_1", label: "M1", name: "Hello", orderIndex: 0 },
      projectOnlyMember
    );
    const list = await MilestoneStore.listForProject(client, "project_1", projectOnlyMember);
    expect(list).toHaveLength(1);
  });
});
