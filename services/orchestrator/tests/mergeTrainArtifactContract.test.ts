// cspell:ignore expmain authsha mainsha headsha
// mq-15 DB-free contract + gate proofs. No database: the strict manifest, the
// deterministic content hash, the member-order guard, and every pure fail-closed gate
// are asserted here (so the negative controls count toward the coverage floor; the RLS
// test proves the same fail-closed behavior end-to-end on real Postgres).

import { describe, expect, it } from "vitest";
import {
  computeMergeTrainContentHash,
  encodeMergeTrainArtifactBytes,
  finalizeMergeTrainArtifact,
  MergeTrainArtifactInvalidError,
  type MergeTrainArtifactBody,
  validateMergeTrainArtifact,
} from "../src/engine/contracts/mergeTrainArtifact.js";
import {
  decisionSatisfies,
  demoIsSuccessful,
  landGroupSatisfies,
  memberSetDigest,
  releaseBindsToLand,
  resolveExactMembers,
  type CompletedData,
  type Evidence,
} from "../src/engine/postMerge/mergeTrainArtifactGates.js";
import { buildBindings, buildDrafts } from "../src/engine/postMerge/mergeTrainArtifactSeal.js";

const SHA = (c: string): string => `sha256:${c.repeat(64)}`;

function body(): MergeTrainArtifactBody {
  return {
    version: 1,
    schemaVersion: "merge_train_artifact.v1",
    orgId: "org1",
    projectId: "proj1",
    landGroupId: "lg1",
    authorityDecisionId: "decision-node1-headsha",
    integrationNodeId: "node1",
    proofRoot: SHA("a"),
    receipt: { mainSha: "mainsha1", auditId: "audit1" },
    members: [
      { ordinal: 0, memberKey: "mk-a", runId: "run-a", specId: "spec-a", prNumber: 11 },
      { ordinal: 1, memberKey: "mk-b", runId: "run-b", specId: "spec-b", prNumber: null },
    ],
    deploy: { provider: "fly", appId: "app1", deploymentId: "dep1", url: "https://x", state: "live" },
    demo: { surfaceKind: "web_url", behaviorCount: 3, passed: 3, failed: 0 },
    sealedBundle: {
      bundleId: "bundle1",
      bundleDigest: SHA("b"),
      proofRoot: SHA("c"),
      bytesDigest: SHA("d"),
      signingKeyId: "key1",
      rootSignatureHex: "abcd",
    },
  };
}

describe("mq-15 MergeTrainArtifactV1 contract", () => {
  it("finalizes + validates a well-formed artifact and is byte-stable", () => {
    const artifact = finalizeMergeTrainArtifact(body());
    expect(artifact.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(() => validateMergeTrainArtifact(artifact)).not.toThrow();
    // The canonical encoding round-trips to the same bytes (idempotent projection).
    expect(encodeMergeTrainArtifactBytes(artifact)).toEqual(encodeMergeTrainArtifactBytes(artifact));
  });

  it("rejects a mutated field (content hash no longer matches)", () => {
    const artifact = { ...finalizeMergeTrainArtifact(body()), proofRoot: SHA("e") };
    expect(() => validateMergeTrainArtifact(artifact)).toThrow(MergeTrainArtifactInvalidError);
  });

  it("rejects a reordered member (order is signed into the hash)", () => {
    const artifact = finalizeMergeTrainArtifact(body());
    const swapped = {
      ...artifact,
      members: [artifact.members[1]!, artifact.members[0]!].map((m, i) => ({ ...m, ordinal: i })),
    };
    expect(() => validateMergeTrainArtifact(swapped)).toThrow(MergeTrainArtifactInvalidError);
  });

  it("rejects out-of-order ordinals even before the hash check", () => {
    const artifact = finalizeMergeTrainArtifact(body());
    const bad = { ...artifact, members: artifact.members.map((m) => ({ ...m, ordinal: m.ordinal + 5 })) };
    expect(() => validateMergeTrainArtifact(bad)).toThrow(/out of order/u);
  });

  it("rejects an unknown key (.strict)", () => {
    const artifact = { ...finalizeMergeTrainArtifact(body()), extra: true };
    expect(() => validateMergeTrainArtifact(artifact)).toThrow(MergeTrainArtifactInvalidError);
  });

  it("computeMergeTrainContentHash is deterministic and order-sensitive", () => {
    const b = body();
    const h1 = computeMergeTrainContentHash(b);
    const reordered: MergeTrainArtifactBody = { ...b, members: [b.members[1]!, b.members[0]!] };
    expect(computeMergeTrainContentHash(reordered)).not.toEqual(h1);
  });
});

const completed: CompletedData = {
  projectId: "proj1",
  landGroupId: "lg1",
  decisionId: "decision-node1-headsha",
  expectedMainSha: "expmain",
  authorizedSha: "headsha",
  mainSha: "mainsha1",
  memberKeys: ["mk-a", "mk-b"],
};

describe("mq-15 pure fail-closed gates", () => {
  it("landGroupSatisfies requires completed state + matching sha + decision", () => {
    const ok = {
      state: "completed",
      main_sha: "mainsha1",
      decision_id: "decision-node1-headsha",
      created_at: new Date(),
    };
    expect(landGroupSatisfies(ok, completed)).toBe(true);
    expect(landGroupSatisfies(undefined, completed)).toBe(false);
    expect(landGroupSatisfies({ ...ok, state: "formed" }, completed)).toBe(false);
    expect(landGroupSatisfies({ ...ok, main_sha: "other" }, completed)).toBe(false);
    expect(landGroupSatisfies({ ...ok, decision_id: "other" }, completed)).toBe(false);
  });

  it("decisionSatisfies rejects cross-project, main-sha drift, OR head_sha≠authorizedSha", () => {
    const ok = {
      project_id: "proj1",
      integration_node_id: "node1",
      proof_root: SHA("a"),
      head_sha: "headsha",
      expected_main_sha: "expmain",
      member_set_hash: "msh",
    };
    expect(decisionSatisfies(ok, completed, "proj1")).toBe(true);
    expect(decisionSatisfies(ok, completed, "other-project")).toBe(false);
    expect(decisionSatisfies({ ...ok, expected_main_sha: "drift" }, completed, "proj1")).toBe(false);
    // Finding 3: a decision authorizing a DIFFERENT head than the land's authorizedSha.
    expect(decisionSatisfies({ ...ok, head_sha: "other-head" }, completed, "proj1")).toBe(false);
    expect(decisionSatisfies(undefined, completed, "proj1")).toBe(false);
  });

  it("demoIsSuccessful demands a full pass (behaviorCount>0, failed=0, passed=count)", () => {
    expect(demoIsSuccessful({ surfaceKind: "web_url", behaviorCount: 2, passed: 2, failed: 0 })).toBe(true);
    expect(demoIsSuccessful({ surfaceKind: "web_url", behaviorCount: 0, passed: 0, failed: 0 })).toBe(false);
    expect(demoIsSuccessful({ surfaceKind: "web_url", behaviorCount: 2, passed: 1, failed: 1 })).toBe(false);
    expect(demoIsSuccessful({ surfaceKind: "web_url", behaviorCount: 2, passed: 2, failed: 1 })).toBe(false);
  });

  const landedRows = [
    { member_key: "mk-b", run_id: "run-b", spec_id: "spec-b", pr_number: null, outcome: "landed" },
    { member_key: "mk-a", run_id: "run-a", spec_id: "spec-a", pr_number: "11", outcome: "landed" },
  ];

  it("resolveExactMembers canonicalizes order + requires exact full set, all landed", () => {
    // Rows arrive out of order; the artifact members are canonicalized (sorted by key).
    const members = resolveExactMembers({
      rows: landedRows,
      completedKeys: ["mk-a", "mk-b"],
      formedKeys: ["mk-b", "mk-a"],
    });
    expect(members).toEqual([
      { ordinal: 0, memberKey: "mk-a", runId: "run-a", specId: "spec-a", prNumber: 11 },
      { ordinal: 1, memberKey: "mk-b", runId: "run-b", specId: "spec-b", prNumber: null },
    ]);
  });

  it("resolveExactMembers fails closed on subset / extra / non-landed / formed-mismatch", () => {
    // (a) completed lists a SUBSET of the real member set → block.
    expect(resolveExactMembers({ rows: landedRows, completedKeys: ["mk-a"], formedKeys: ["mk-a"] })).toBeUndefined();
    // (b) completed lists an EXTRA/foreign key not in the table → block.
    expect(
      resolveExactMembers({
        rows: landedRows,
        completedKeys: ["mk-a", "mk-b", "mk-x"],
        formedKeys: ["mk-a", "mk-b", "mk-x"],
      }),
    ).toBeUndefined();
    // (c) a member whose outcome is not 'landed' → block.
    const reverted = [landedRows[0]!, { ...landedRows[1]!, outcome: "reverted" }];
    expect(
      resolveExactMembers({ rows: reverted, completedKeys: ["mk-a", "mk-b"], formedKeys: ["mk-a", "mk-b"] }),
    ).toBeUndefined();
    // (d) group.formed disagrees with the completed member set → block.
    expect(
      resolveExactMembers({ rows: landedRows, completedKeys: ["mk-a", "mk-b"], formedKeys: ["mk-a", "mk-x"] }),
    ).toBeUndefined();
    // (e) Finding 3: an empty-string / whitespace run identity is rejected AT THE GATE.
    const blankId = [landedRows[0]!, { ...landedRows[1]!, run_id: "" }];
    expect(
      resolveExactMembers({ rows: blankId, completedKeys: ["mk-a", "mk-b"], formedKeys: ["mk-a", "mk-b"] }),
    ).toBeUndefined();
    const blankSpec = [landedRows[0]!, { ...landedRows[1]!, spec_id: "   " }];
    expect(
      resolveExactMembers({ rows: blankSpec, completedKeys: ["mk-a", "mk-b"], formedKeys: ["mk-a", "mk-b"] }),
    ).toBeUndefined();
  });

  it("memberSetDigest is order-insensitive over the resolved set", () => {
    expect(memberSetDigest(["mk-a", "mk-b"])).toBe(memberSetDigest(["mk-b", "mk-a"]));
    expect(memberSetDigest(["mk-a", "mk-b"])).not.toBe(memberSetDigest(["mk-a", "mk-c"]));
  });

  it("releaseBindsToLand requires a LIVE production release FOR the sealed tip", () => {
    const live = { source_ref: "mainsha1", state: "live", environment: "production" };
    expect(releaseBindsToLand(live, completed)).toBe(true);
    expect(releaseBindsToLand({ ...live, source_ref: "headsha" }, completed)).toBe(true);
    // A prior/unrelated SHA does not satisfy the gate.
    expect(releaseBindsToLand({ ...live, source_ref: "prior-sha" }, completed)).toBe(false);
    // Finding 2: an INTERMEDIATE (non-live) state for the tip SHA is blocked.
    for (const state of ["built", "preview", "promoting", "superseded", "rolled_back", "torn_down", "failed"]) {
      expect(releaseBindsToLand({ ...live, state }, completed)).toBe(false);
    }
    // A live but NON-production (preview) environment is blocked.
    expect(releaseBindsToLand({ ...live, environment: "preview" }, completed)).toBe(false);
    expect(releaseBindsToLand(undefined, completed)).toBe(false);
  });

  it("buildDrafts emits proof-root, ordered members, deploy, then demo", () => {
    const artifact = finalizeMergeTrainArtifact(body());
    const drafts = buildDrafts(artifact);
    expect(drafts.map((d) => d.subjectId)).toEqual(["node1", "mk-a", "mk-b", "dep1", "lg1"]);
    expect(drafts.at(-1)?.kind).toBe("runtime_behavior");
  });

  it("buildBindings derives a deterministic nonce + carries the decision identity", () => {
    const evidence = evidenceFixture();
    const bindings = buildBindings(evidence, SHA("9") as never);
    expect(bindings.nonce).toBe("land-group-lg1");
    expect(bindings.integrationNodeId).toBe("node1");
    expect(bindings.preparedHeadSha).toBe("headsha");
    expect(bindings.artifactDigest).toBe(SHA("9"));
  });
});

export function evidenceFixture(): Evidence {
  return {
    lineage: { runId: "run-b", specId: "spec-b", projectId: "proj1", orgId: "org1" },
    completed,
    decision: {
      project_id: "proj1",
      integration_node_id: "node1",
      proof_root: SHA("a"),
      head_sha: "headsha",
      expected_main_sha: "expmain",
      member_set_hash: "msh",
    },
    issuedAt: "2026-07-20T00:00:00.000Z",
    receiptAuditId: "audit1",
    receiptMainSha: "mainsha1",
    members: [
      { ordinal: 0, memberKey: "mk-a", runId: "run-a", specId: "spec-a", prNumber: 11 },
      { ordinal: 1, memberKey: "mk-b", runId: "run-b", specId: "spec-b", prNumber: null },
    ],
    deploy: { provider: "fly", appId: "app1", deploymentId: "dep1", url: "https://x", state: "live" },
    demo: { surfaceKind: "web_url", behaviorCount: 3, passed: 3, failed: 0 },
  };
}
