// cspell:ignore rdec vassert
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ResolutionEvidenceSnapshot } from "../src/engine/contracts/resolutionAuthority.js";
import {
  ResolutionAuthority,
  decideResolution,
  resolutionSnapshotHash,
} from "../src/engine/governance/resolutionAuthority.js";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function evidence(overrides: Partial<ResolutionEvidenceSnapshot> = {}): ResolutionEvidenceSnapshot {
  const run = { verificationRunId: "vrun_evidence", artifactDigest: digest("artifact"), mergeSha: "a".repeat(40) };
  return {
    version: "tanren-resolution-evidence.v1",
    orgId: "org_resolution",
    projectId: "project_resolution",
    resolutionJobId: "rjob_resolution",
    issueLoopId: "iloop_resolution",
    contract: { id: "contract_resolution", hash: digest("contract"), sourceRevision: "source-revision" },
    baseline: { ...run, verificationRunId: "vrun_baseline" },
    counterfactual: { ...run, verificationRunId: "vrun_counterfactual" },
    soak: null,
    merge: { authorityAuditId: "audit_merge", sha: run.mergeSha },
    deployment: {
      releaseInstanceId: "release_resolution",
      artifactDigest: run.artifactDigest,
      mergeSha: run.mergeSha,
    },
    production: {
      ...run,
      outcome: "passed",
      classification: "product_resolved",
      assertionOutcomes: [{ id: "vassert_production", outcome: "passed" }],
    },
    proofGrade: "active_causal",
    resolutionPolicy: "active_causal",
    ...overrides,
  };
}

describe("ResolutionAuthority — fail-closed evidence truth table", () => {
  it("authorizes only a complete real-fix snapshot and hashes it deterministically", () => {
    const first = evidence();
    const reordered = {
      ...first,
      contract: { sourceRevision: "source-revision", id: "contract_resolution", hash: digest("contract") },
    };
    expect(decideResolution(first)).toEqual({ decision: "authorized", reasons: [] });
    expect(resolutionSnapshotHash(first)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(resolutionSnapshotHash(reordered)).toBe(resolutionSnapshotHash(first));
  });

  it("blocks a cosmetic fix even when unrelated reachability/demo checks were green", () => {
    const cosmetic = evidence({
      production: {
        ...evidence().production,
        outcome: "failed",
        classification: "product_failure",
        assertionOutcomes: [{ id: "vassert_symptom", outcome: "failed" }],
      },
    });
    expect(decideResolution(cosmetic)).toMatchObject({
      decision: "blocked",
      reasons: ["production symptom verification did not pass"],
    });
  });

  it("routes an infrastructure/inconclusive production probe to needs_attention, never authorization", () => {
    const inconclusive = evidence({
      production: {
        ...evidence().production,
        outcome: "inconclusive",
        classification: "infra_failure",
        assertionOutcomes: [],
      },
    });
    expect(decideResolution(inconclusive)).toMatchObject({ decision: "needs_attention" });
  });

  it("persists only decisions made through authorize or authenticated operator waive", async () => {
    const recorded: unknown[] = [];
    const authority = new ResolutionAuthority(
      { snapshot: async () => evidence() },
      {
        async record(input) {
          recorded.push(input);
          return { id: `rdec_${input.decision}`, created: true };
        },
      },
    );
    await expect(
      authority.authorize({ orgId: "org_resolution", resolutionJobId: "rjob_resolution" }),
    ).resolves.toMatchObject({
      decision: "authorized",
      inputSnapshotHash: expect.stringMatching(/^sha256:/u),
    });
    await expect(
      authority.waive({
        orgId: "org_resolution",
        resolutionJobId: "rjob_resolution",
        operatorId: "operator_a",
        reason: "operator accepted the attested device evidence",
      }),
    ).resolves.toMatchObject({ decision: "waived" });
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toMatchObject({
      decision: "waived",
      authorityVersion: "tanren-resolution-authority.v1",
      decisionReasons: ["operator waiver recorded"],
      snapshot: { waiver: { operatorId: "operator_a" } },
    });
  });
});
