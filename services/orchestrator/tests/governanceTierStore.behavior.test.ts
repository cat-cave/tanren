import { describe, expect, it } from "vitest";
import { compilePolicy } from "../src/engine/governance/policyCompiler.js";
import {
  bindGovernanceTier,
  createGovernanceTier,
  GovernanceTierNotFoundError,
  listGovernanceTiers,
} from "../src/engine/governance/governanceTierStore.js";
import { GOVERNANCE_TIER_PRESET_NAMES, governanceTierPreset } from "../src/engine/governance/tierPresets.js";
import { GovernanceStoreMemoryClient } from "./helpers/governanceStoreMemoryClient.js";

const orgId = "org_governance_tier";
const projectId = "project_governance_tier";

function clientWithProject(): GovernanceStoreMemoryClient {
  const client = new GovernanceStoreMemoryClient();
  client.seedProject(orgId, projectId);
  return client;
}

describe("governance tiers — compiled activation rules", () => {
  it("persists every named preset as its deterministic, immutable canonical policy", async () => {
    const client = clientWithProject();
    const created = [];
    for (const preset of GOVERNANCE_TIER_PRESET_NAMES) {
      const compiled = compilePolicy(governanceTierPreset(preset).sourceDocument);
      expect(compiled.status).toBe("compiled");
      if (compiled.status !== "compiled") throw new Error(`preset ${preset} must compile`);
      const tier = await createGovernanceTier(client as never, {
        orgId,
        projectId,
        tierName: `tier-${preset}`,
        preset,
      });
      created.push(tier);
      expect(tier).toMatchObject({
        preset,
        tierJson: governanceTierPreset(preset).sourceDocument,
        canonicalHash: compiled.policyHash,
        state: "active",
      });
      expect(compilePolicy(tier.tierJson)).toMatchObject({ status: "compiled", policyHash: tier.canonicalHash });
    }

    expect((await listGovernanceTiers(client as never, orgId, projectId)).map((tier) => tier.id)).toEqual(
      created.map((tier) => tier.id),
    );
    await expect(client.query("UPDATE governance_tiers SET state = 'tampered'")).rejects.toThrow(/append-only/u);
  });

  it("rejects an activation for a tier that is not in the project's immutable catalog", async () => {
    const client = clientWithProject();
    await expect(
      bindGovernanceTier(client as never, {
        orgId,
        projectId,
        tierId: "governance_tier_missing",
      }),
    ).rejects.toBeInstanceOf(GovernanceTierNotFoundError);
  });

  it("keeps exactly one active binding and re-promotes A after A → B without minting another A binding", async () => {
    const client = clientWithProject();
    const tierA = await createGovernanceTier(client as never, {
      orgId,
      projectId,
      tierName: "standard-tier",
      preset: "standard",
    });
    const tierB = await createGovernanceTier(client as never, {
      orgId,
      projectId,
      tierName: "private-tier",
      preset: "private",
    });

    const firstA = await bindGovernanceTier(client as never, {
      orgId,
      projectId,
      tierId: tierA.id,
      createdBy: "user_governance",
    });
    const repeatedA = await bindGovernanceTier(client as never, {
      orgId,
      projectId,
      tierId: tierA.id,
      createdBy: "user_governance",
    });
    expect(repeatedA).toMatchObject({
      binding: { id: firstA.binding.id, isActive: true },
      policyRevisionId: firstA.policyRevisionId,
    });
    expect(client.bindings).toHaveLength(1);
    expect(client.revisions).toHaveLength(1);
    expect(client.snapshots).toHaveLength(1);

    const activatedB = await bindGovernanceTier(client as never, {
      orgId,
      projectId,
      tierId: tierB.id,
      createdBy: "user_governance",
    });
    const rePromotedA = await bindGovernanceTier(client as never, {
      orgId,
      projectId,
      tierId: tierA.id,
      createdBy: "user_governance",
    });

    expect(rePromotedA).toMatchObject({
      binding: { id: firstA.binding.id, tierId: tierA.id, isActive: true },
      policyRevisionId: firstA.policyRevisionId,
    });
    expect(client.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstA.binding.id, tier_id: tierA.id, is_active: true }),
        expect.objectContaining({ id: activatedB.binding.id, tier_id: tierB.id, is_active: false }),
      ]),
    );
    expect(client.bindings.filter((binding) => binding.is_active === true)).toHaveLength(1);
    expect(client.projectVisibility(orgId, projectId)).toBe("public");
    expect(client.events.filter((event) => event.eventType === "governance.binding.activated")).toHaveLength(3);
    expect(client.events.filter((event) => event.eventType === "governance.binding.superseded")).toHaveLength(2);
    expect(client.snapshots).toHaveLength(3);

    await expect(
      client.query("INSERT INTO policy_bindings (org_id, project_id, id, tier_id, effective_policy_hash, is_active)", [
        orgId,
        projectId,
        "policy_binding_second_active",
        tierB.id,
        tierB.canonicalHash,
      ]),
    ).rejects.toThrow(/policy_bindings_one_active_per_project/u);
  });
});
