import { describe, expect, it } from "vitest";
import {
  activatePolicyRevision,
  compilePolicyRevision,
  createPolicyRevision,
  findPolicyRevisionByHash,
  getPolicyRevision,
  PolicyContradictionError,
  PolicyRevisionIntegrityError,
  PolicyRevisionNotFoundError,
  validatePolicyRevision,
} from "../src/engine/governance/policyRevisionStore.js";
import { compilePolicy } from "../src/engine/governance/policyCompiler.js";
import type { PolicyAst } from "../src/engine/governance/policyAst.js";
import { GovernanceStoreMemoryClient } from "./helpers/governanceStoreMemoryClient.js";

const orgId = "org_governance_revision";
const projectId = "project_governance_revision";

function policy(): PolicyAst {
  return {
    apiVersion: "tanren.dev/governance/v2",
    schemaVersion: 1,
    core: { rules: [{ key: "repository.visibility", value: "public" }] },
    org: { rules: [{ key: "review.freshness", value: "exact_head_sha" }] },
    tier: { rules: [{ key: "review.minimum_approvals", value: 1 }] },
    binding: { rules: [] },
  };
}

function clientWithProject(): GovernanceStoreMemoryClient {
  const client = new GovernanceStoreMemoryClient();
  client.seedProject(orgId, projectId);
  return client;
}

describe("policy revisions — append-only business rules", () => {
  it("allocates a monotonic per-project revision ledger and preserves immutable lineage", async () => {
    const client = clientWithProject();
    const first = await createPolicyRevision(client as never, {
      orgId,
      projectId,
      sourceDocument: policy(),
      createdBy: "user_governance",
    });
    const second = await createPolicyRevision(client as never, {
      orgId,
      projectId,
      sourceDocument: policy(),
      parentRevisionId: first.id,
      createdBy: "user_governance",
    });

    expect(first).toMatchObject({ revisionNumber: 1, parentRevisionId: undefined, createdBy: "user_governance" });
    expect(second).toMatchObject({ revisionNumber: 2, parentRevisionId: first.id });
    expect(second.policyHash).toBe(first.policyHash);
    expect((await getPolicyRevision(client as never, orgId, projectId, "2")).id).toBe(second.id);
    expect((await findPolicyRevisionByHash(client as never, orgId, projectId, first.policyHash))?.id).toBe(second.id);

    await expect(client.query("UPDATE governance_policy_revisions SET created_by = 'tampered'")).rejects.toThrow(
      /append-only/u,
    );
  });

  it("stores the deterministic compiler output and rejects a contradictory policy before allocating a revision", async () => {
    const client = clientWithProject();
    const source = policy();
    const expected = compilePolicy(source);
    expect(expected.status).toBe("compiled");
    if (expected.status !== "compiled") throw new Error("expected a compilable policy");

    const revision = await createPolicyRevision(client as never, {
      orgId,
      projectId,
      sourceDocument: source,
      createdBy: "user_governance",
    });
    expect(revision.compiledAst).toEqual(expected.ast);
    expect(revision.policyHash).toBe(expected.policyHash);
    await expect(validatePolicyRevision(source)).resolves.toMatchObject({ policyHash: expected.policyHash });

    const contradictory: PolicyAst = {
      ...source,
      binding: {
        rules: [
          { key: "review.mode", value: "auto" },
          { key: "review.mode", value: "human" },
        ],
      },
    };
    const error = await createPolicyRevision(client as never, {
      orgId,
      projectId,
      sourceDocument: contradictory,
      createdBy: "user_governance",
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PolicyContradictionError);
    expect((error as PolicyContradictionError).witnesses).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "conflicting_review_modes", layer: "binding" })]),
    );
    expect(client.revisions).toHaveLength(1);
  });

  it("rejects missing and cross-project parents rather than forging policy lineage", async () => {
    const client = clientWithProject();
    await expect(
      createPolicyRevision(client as never, {
        orgId,
        projectId,
        sourceDocument: policy(),
        parentRevisionId: "policy_revision_missing",
        createdBy: "user_governance",
      }),
    ).rejects.toBeInstanceOf(PolicyRevisionNotFoundError);

    const parent = await createPolicyRevision(client as never, {
      orgId,
      projectId: "project_governance_other",
      sourceDocument: policy(),
      createdBy: "user_governance",
    });
    await expect(
      createPolicyRevision(client as never, {
        orgId,
        projectId,
        sourceDocument: policy(),
        parentRevisionId: parent.id,
        createdBy: "user_governance",
      }),
    ).rejects.toThrow("parent policy revision belongs to another project");
  });

  it("fails closed on a non-reproducible stored compilation and emits each lifecycle fact once", async () => {
    const client = clientWithProject();
    const revision = await createPolicyRevision(client as never, {
      orgId,
      projectId,
      sourceDocument: policy(),
      createdBy: "user_governance",
    });

    await compilePolicyRevision(client as never, orgId, revision);
    await activatePolicyRevision(client as never, orgId, revision);
    await activatePolicyRevision(client as never, orgId, revision);
    expect(client.events.map((event) => event.eventType)).toEqual([
      "governance.policy.created",
      "governance.policy.compiled",
      "governance.policy.activated",
    ]);

    const stored = client.revisions.find((row) => row.id === revision.id);
    if (stored === undefined) throw new Error("expected revision to be stored");
    const compiledAst = stored.compiled_ast as Record<string, unknown>;
    stored.compiled_ast = { ...compiledAst, rules: [] };
    const corrupted = await getPolicyRevision(client as never, orgId, projectId, revision.id);
    await expect(compilePolicyRevision(client as never, orgId, corrupted)).rejects.toBeInstanceOf(
      PolicyRevisionIntegrityError,
    );
  });
});
