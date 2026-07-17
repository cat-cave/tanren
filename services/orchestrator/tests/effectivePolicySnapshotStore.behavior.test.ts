import { describe, expect, it } from "vitest";
import {
  EffectivePolicyBindingNotFoundError,
  EffectivePolicyIntegrityError,
  getEffectivePolicySnapshot,
  recordEffectivePolicySnapshot,
} from "../src/engine/governance/effectivePolicySnapshotStore.js";
import { compilePolicy } from "../src/engine/governance/policyCompiler.js";
import {
  bindGovernanceTier,
  createGovernanceTier,
  type GovernanceTier,
  type PolicyBinding,
} from "../src/engine/governance/governanceTierStore.js";
import { policyHash } from "../src/engine/governance/policyHash.js";
import { GovernanceStoreMemoryClient } from "./helpers/governanceStoreMemoryClient.js";

const orgId = "org_effective_policy_snapshot";
const projectId = "project_effective_policy_snapshot";

async function activePolicy(
  client: GovernanceStoreMemoryClient,
  preset: "open" | "standard" | "private" | "regulated" = "standard",
): Promise<{ tier: GovernanceTier; binding: PolicyBinding; policyRevisionId: string }> {
  client.seedProject(orgId, projectId);
  const tier = await createGovernanceTier(client as never, {
    orgId,
    projectId,
    tierName: `tier-${preset}`,
    preset,
  });
  return bindGovernanceTier(client as never, { orgId, projectId, tierId: tier.id, createdBy: "user_governance" });
}

describe("effective policy snapshots — business receipts", () => {
  it("rejects a receipt without an active binding", async () => {
    const client = new GovernanceStoreMemoryClient();
    client.seedProject(orgId, projectId);
    await expect(
      recordEffectivePolicySnapshot(client as never, {
        orgId,
        projectId,
        subjectKind: "run",
        subjectId: "run_without_policy",
        createdBy: "user_governance",
      }),
    ).rejects.toBeInstanceOf(EffectivePolicyBindingNotFoundError);
  });

  it("freezes the active compiled policy, identifiers, and all receipt inputs", async () => {
    const client = new GovernanceStoreMemoryClient();
    const { tier, binding, policyRevisionId } = await activePolicy(client);
    const inputs = { baseSha: "base_123", headSha: "head_456", risk: "high" };
    const first = await recordEffectivePolicySnapshot(client as never, {
      orgId,
      projectId,
      inputs,
      subjectKind: "change",
      subjectId: "change_123",
      createdBy: "user_governance",
    });
    const compiled = compilePolicy(tier.tierJson);
    expect(compiled.status).toBe("compiled");
    if (compiled.status !== "compiled") throw new Error("tier preset must compile");
    const expectedDigest = policyHash({
      bindingId: binding.id,
      policyRevisionId,
      projectId,
      inputs,
      subjectId: "change_123",
      subjectKind: "change",
    });

    expect(first).toMatchObject({
      bindingId: binding.id,
      tierId: tier.id,
      policyRevisionId,
      effectivePolicyHash: tier.canonicalHash,
      compiledBody: compiled.ast,
      inputsDigest: expectedDigest,
      subjectKind: "change",
      subjectId: "change_123",
    });
    const receiptEvent = client.events.findLast((event) => event.eventType === "governance.effective_policy.recorded");
    expect(receiptEvent?.payload).toEqual({
      projectId,
      snapshotId: first.id,
      bindingId: binding.id,
      tierId: tier.id,
      policyRevisionId,
      effectivePolicyHash: tier.canonicalHash,
      subjectKind: "change",
      subjectId: "change_123",
      inputsDigest: expectedDigest,
    });
  });

  it("makes repeated receipts append-only while keeping identical inputs deterministic", async () => {
    const client = new GovernanceStoreMemoryClient();
    await activePolicy(client);
    const input = {
      orgId,
      projectId,
      inputs: { headSha: "head_repeat" },
      subjectKind: "run" as const,
      subjectId: "run_repeat",
      createdBy: "user_governance",
    };
    const first = await recordEffectivePolicySnapshot(client as never, input);
    const second = await recordEffectivePolicySnapshot(client as never, input);
    const changedInputs = await recordEffectivePolicySnapshot(client as never, {
      ...input,
      inputs: { headSha: "head_changed" },
    });

    expect(second.id).not.toBe(first.id);
    expect(second.compiledBody).toEqual(first.compiledBody);
    expect(second.effectivePolicyHash).toBe(first.effectivePolicyHash);
    expect(second.inputsDigest).toBe(first.inputsDigest);
    expect(changedInputs.inputsDigest).not.toBe(first.inputsDigest);
    expect(await getEffectivePolicySnapshot(client as never, orgId, projectId, "run", "run_repeat")).toMatchObject({
      id: changedInputs.id,
      inputsDigest: changedInputs.inputsDigest,
    });
    await expect(client.query("UPDATE effective_policy_snapshots SET subject_id = 'tampered'")).rejects.toThrow(
      /append-only/u,
    );
  });

  it("rejects a requested inactive binding and a policy whose binding no longer has a reproducible revision", async () => {
    const client = new GovernanceStoreMemoryClient();
    const first = await activePolicy(client, "standard");
    const secondTier = await createGovernanceTier(client as never, {
      orgId,
      projectId,
      tierName: "tier-private",
      preset: "private",
    });
    const second = await bindGovernanceTier(client as never, {
      orgId,
      projectId,
      tierId: secondTier.id,
      createdBy: "user_governance",
    });

    await expect(
      recordEffectivePolicySnapshot(client as never, {
        orgId,
        projectId,
        bindingId: first.binding.id,
        subjectKind: "run",
        subjectId: "run_inactive_binding",
        createdBy: "user_governance",
      }),
    ).rejects.toBeInstanceOf(EffectivePolicyBindingNotFoundError);

    const activeBinding = client.bindings.find((binding) => binding.id === second.binding.id);
    if (activeBinding === undefined) throw new Error("expected active binding");
    activeBinding.effective_policy_hash = `sha256:${"0".repeat(64)}`;
    await expect(
      recordEffectivePolicySnapshot(client as never, {
        orgId,
        projectId,
        subjectKind: "run",
        subjectId: "run_corrupted_policy",
        createdBy: "user_governance",
      }),
    ).rejects.toBeInstanceOf(EffectivePolicyIntegrityError);
  });
});
