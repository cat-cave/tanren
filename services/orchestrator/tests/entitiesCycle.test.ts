import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  CyclicSpecDependencyError,
  SelfSpecDependencyError,
  SpecDependencyStore,
  assertNoCycle
} from "../src/engine/entities/index.js";
import { EntityMemoryClient } from "./helpers/entityMemoryClient.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_1",
  projectId: null,
  scopes: ["org:admin", "org:member"],
  source: "session"
};

describe("SpecDependencyStore cycle detection", () => {
  it("inserts a -> b without complaint", async () => {
    const client = new EntityMemoryClient();
    const row = await SpecDependencyStore.insert(client, { fromSpecId: "spec_a", toSpecId: "spec_b" }, actor);
    expect(row.fromSpecId).toBe("spec_a");
  });

  it("rejects a self-loop", async () => {
    const client = new EntityMemoryClient();
    await expect(
      SpecDependencyStore.insert(client, { fromSpecId: "spec_a", toSpecId: "spec_a" }, actor)
    ).rejects.toThrowError(SelfSpecDependencyError);
  });

  it("rejects a cycle a -> b -> c -> a with a printable path", async () => {
    const client = new EntityMemoryClient();
    await SpecDependencyStore.insert(client, { fromSpecId: "spec_a", toSpecId: "spec_b" }, actor);
    await SpecDependencyStore.insert(client, { fromSpecId: "spec_b", toSpecId: "spec_c" }, actor);
    const error = await SpecDependencyStore.insert(
      client,
      { fromSpecId: "spec_c", toSpecId: "spec_a" },
      actor
    ).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(CyclicSpecDependencyError);
    const cycle = (error as CyclicSpecDependencyError).cycle;
    expect(cycle[0]).toBe("spec_c");
    expect(cycle[cycle.length - 1]).toBe("spec_c");
    expect(cycle).toContain("spec_a");
    expect(cycle).toContain("spec_b");
    expect((error as Error).message).toContain("spec_c");
  });

  it("does not flag a fresh edge that does not close a cycle", async () => {
    const client = new EntityMemoryClient();
    await SpecDependencyStore.insert(client, { fromSpecId: "spec_a", toSpecId: "spec_b" }, actor);
    await SpecDependencyStore.insert(client, { fromSpecId: "spec_a", toSpecId: "spec_c" }, actor);
    await expect(
      SpecDependencyStore.insert(client, { fromSpecId: "spec_c", toSpecId: "spec_b" }, actor)
    ).resolves.toBeDefined();
  });

  it("assertNoCycle is a no-op on an empty graph", async () => {
    const client = new EntityMemoryClient();
    await expect(assertNoCycle(client, "spec_a", "spec_b")).resolves.toBeUndefined();
  });

  it("lists outgoing and incoming edges", async () => {
    const client = new EntityMemoryClient();
    await SpecDependencyStore.insert(client, { fromSpecId: "spec_a", toSpecId: "spec_b" }, actor);
    await SpecDependencyStore.insert(client, { fromSpecId: "spec_a", toSpecId: "spec_c" }, actor);
    await SpecDependencyStore.insert(client, { fromSpecId: "spec_d", toSpecId: "spec_b" }, actor);
    const outgoing = await SpecDependencyStore.listOutgoing(client, "spec_a", actor);
    expect(outgoing.map((e) => e.toSpecId).sort()).toEqual(["spec_b", "spec_c"]);
    const incoming = await SpecDependencyStore.listIncoming(client, "spec_b", actor);
    expect(incoming.map((e) => e.fromSpecId).sort()).toEqual(["spec_a", "spec_d"]);
  });
});
