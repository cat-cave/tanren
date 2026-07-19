import { describe, expect, it, vi } from "vitest";
import { compilePolicy } from "../policyCompiler.js";
import type { PolicyAst } from "../policyAst.js";
import {
  GovernanceFragmentAuthoringFailedError,
  policyFromLayers,
  resolveGovernanceFragmentConfig,
  type GovernanceFragmentDraft,
  type GovernanceFragmentSpec,
  type ValidatedGovernanceFragment,
} from "./index.js";
import type { GovernanceFragmentPersistenceStore } from "./store.js";

const context = { orgId: "org-gv10", projectId: "project-gv10", createdBy: "operator-gv10" };

function policyHash(policy: PolicyAst): string {
  const result = compilePolicy(policy);
  if (result.status !== "compiled") throw new Error("fixture policy must compile");
  return result.policyHash;
}

function draft(spec: GovernanceFragmentSpec): GovernanceFragmentDraft {
  const policy = policyFromLayers(spec.requiredPolicy);
  return {
    spec,
    policy: spec.requiredPolicy,
    conformance: { positive: [policy], negative: [{ apiVersion: "invalid" }] },
    simulatorSnapshots: [{ scenarioId: "happy", policy, expectedPolicyHash: policyHash(policy) }],
    uiFormSchema: { type: "object", title: spec.fragmentId },
    compatibility: "tanren.dev/governance/v2",
  };
}

function config(): {
  apiVersion: "tanren.dev/governance-fragments/v1";
  schemaVersion: 1;
  fragments: GovernanceFragmentSpec[];
} {
  return {
    apiVersion: "tanren.dev/governance-fragments/v1",
    schemaVersion: 1,
    fragments: [
      {
        fragmentId: "private-repository",
        version: "1.0.0",
        dependsOn: ["review"],
        derivation: {
          personaRevisionIds: ["persona-private"],
          behaviorRevisionIds: ["behavior-private"],
          designEntityIds: ["repository"],
          riskClassifications: ["confidentiality"],
        },
        requiredPolicy: {
          core: { rules: [] },
          org: { rules: [{ key: "repository.visibility", value: "private" }] },
          tier: { rules: [] },
          binding: { rules: [] },
        },
      },
      {
        fragmentId: "review",
        version: "1.0.0",
        dependsOn: ["base"],
        derivation: {
          personaRevisionIds: ["persona-reviewer"],
          behaviorRevisionIds: ["behavior-review"],
          designEntityIds: ["pull-request"],
          riskClassifications: ["change-control"],
        },
        requiredPolicy: {
          core: { rules: [] },
          org: { rules: [] },
          tier: { rules: [{ key: "review.minimum_approvals", value: 2 }] },
          binding: { rules: [] },
        },
      },
    ],
  };
}

function memoryStore(): GovernanceFragmentPersistenceStore {
  let rows: ValidatedGovernanceFragment[] = [];
  return {
    async createValidated(input) {
      const id = `${input.fragment.draft.spec.fragmentId}@${input.fragment.draft.spec.version}`;
      if (rows.some((row) => row.draft.spec.fragmentId === input.fragment.draft.spec.fragmentId))
        throw new Error("duplicate");
      rows = [...rows, input.fragment];
      return { persistedId: id };
    },
    async deleteById(_orgId, id) {
      rows = rows.filter((row) => `${row.draft.spec.fragmentId}@${row.draft.spec.version}` !== id);
    },
    async listValidated() {
      return rows;
    },
  };
}

function eventStore() {
  const eventTypes: string[] = [];
  return {
    eventTypes,
    sink: {
      async append(input: { eventType: string }) {
        eventTypes.push(input.eventType);
      },
    },
  };
}

describe("gv-10 governance fragment production composer", () => {
  it("drives the shared F2 kernel on a missing dependency-ordered fragment set, then composes the policy", async () => {
    const store = memoryStore();
    const events = eventStore();
    const author = vi.fn<(input: { spec: GovernanceFragmentSpec }) => Promise<GovernanceFragmentDraft>>(
      async ({ spec }) => draft(spec),
    );

    const first = await resolveGovernanceFragmentConfig({
      config: config(),
      context,
      authorer: { author },
      store,
      eventStore: events.sink,
    });
    expect(author.mock.calls.map(([input]) => input.spec.fragmentId)).toEqual(["review", "private-repository"]);
    expect(first.snapshot.map((entry) => entry.fragmentId)).toEqual(["base", "review", "private-repository"]);
    expect(first.policy.tier.rules).toEqual([{ key: "review.minimum_approvals", value: 2 }]);
    expect(events.eventTypes).toEqual(
      expect.arrayContaining([
        "governanceFragment.authoring.started",
        "governanceFragment.authoring.attempt",
        "governanceFragment.authoring.succeeded",
      ]),
    );

    await resolveGovernanceFragmentConfig({
      config: config(),
      context,
      authorer: { author },
      store,
      eventStore: events.sink,
    });
    expect(author).toHaveBeenCalledTimes(2);
  });

  it("fails closed and persists nothing when the writer cannot produce a valid declarative fragment", async () => {
    const store = memoryStore();
    const events = eventStore();
    const author = vi.fn<(input: { spec: GovernanceFragmentSpec }) => Promise<GovernanceFragmentDraft>>(
      async ({ spec }) => {
        const valid = draft(spec);
        return {
          ...valid,
          policy: {
            ...spec.requiredPolicy,
            binding: { rules: [{ key: "review.minimum_approvals", value: 99 }] },
          },
        };
      },
    );

    await expect(
      resolveGovernanceFragmentConfig({
        config: config(),
        context,
        authorer: { author },
        store,
        eventStore: events.sink,
      }),
    ).rejects.toBeInstanceOf(GovernanceFragmentAuthoringFailedError);
    expect(await store.listValidated(context.orgId)).toEqual([]);
    expect(events.eventTypes).toContain("governanceFragment.authoring.failed");
  });
});
