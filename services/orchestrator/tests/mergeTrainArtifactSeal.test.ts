// cspell:ignore expmain mainsha headsha
// mq-15 DB-free seal + gather + store proofs. Fake `ProofSubstrate` / `CasByteStore` /
// sink exercise the seal happy path AND the tamper path (a bundle the substrate cannot
// verify persists NOTHING). A fake query client drives `gatherEvidenceFromClient` through
// its fail-closed arms. The store's read mappers run over a fake client. No database.

import { describe, expect, it, vi } from "vitest";
import type {
  BundleBindings,
  CasArtifactRef,
  Digest,
  ProofBundleRef,
  ProofBundleSealed,
  ProofSubstrate,
  ProofUnitRef,
} from "../src/engine/contracts/cas.js";
import { validateMergeTrainArtifact } from "../src/engine/contracts/mergeTrainArtifact.js";
import { gatherEvidenceFromClient } from "../src/engine/postMerge/mergeTrainArtifactGates.js";
import {
  type MergeTrainPersistInput,
  type MergeTrainSealSink,
  sealEvidence,
} from "../src/engine/postMerge/mergeTrainArtifactSeal.js";
import { PgMergeTrainArtifactStore } from "../src/engine/postMerge/mergeTrainArtifactStore.js";
import { evidenceFixture } from "./mergeTrainArtifactContract.test.js";

const SHA = (c: string): Digest => `sha256:${c.repeat(64)}` as Digest;

function fakeSubstrate(verifyValid: boolean): ProofSubstrate {
  return {
    ingestUnits: async ({ drafts }) =>
      drafts.map(
        (d, i) => ({ digest: SHA(String(i % 10).repeat(1) || "1"), kind: d.kind, verdict: d.verdict }) as ProofUnitRef,
      ),
    computeRoot: () => SHA("c"),
    seal: async () => ({ signingKeyId: "test-key", rootSignature: new Uint8Array([0xab, 0xcd]) }),
    constructBundle: async ({ members, bindings }: { members: readonly ProofUnitRef[]; bindings: BundleBindings }) =>
      ({
        bundleId: "bundle-1",
        bundleDigest: SHA("b"),
        proofRoot: SHA("c"),
        members: members.map((m, i) => ({
          bundleUnitId: `u${i}`,
          unitDigest: m.digest,
          kind: m.kind,
          verdict: m.verdict,
          ordinal: i,
        })),
        bindings,
        bytesDigest: SHA("d"),
        signingKeyId: "test-key",
        rootSignature: new Uint8Array([0xab, 0xcd]),
      }) satisfies ProofBundleSealed,
    verify: async () => ({ valid: verifyValid, ...(verifyValid ? {} : { reason: "tampered" }) }),
    persistBundle: async (b: ProofBundleSealed): Promise<ProofBundleRef> => ({
      bundleId: b.bundleId,
      bundleDigest: b.bundleDigest,
      proofRoot: b.proofRoot,
      bytesDigest: b.bytesDigest,
      members: b.members,
    }),
  };
}

function freshCas() {
  return {
    put: vi.fn<(input: { orgId: string; bytes: Uint8Array; mediaType: string }) => Promise<CasArtifactRef>>(
      async (input) => ({ digest: SHA("e"), byteSize: input.bytes.length, mediaType: input.mediaType }),
    ),
    get: vi.fn<() => Promise<never>>(),
    has: vi.fn<() => Promise<boolean>>(),
  };
}

function recordingSink(): { sink: MergeTrainSealSink; calls: MergeTrainPersistInput[] } {
  const calls: MergeTrainPersistInput[] = [];
  return {
    calls,
    sink: {
      persist: async (input) => {
        calls.push(input);
        return { inserted: true };
      },
    },
  };
}

describe("mq-15 sealEvidence", () => {
  it("seals a verified train: persists once, and the artifact validates off-line", async () => {
    const { sink, calls } = recordingSink();
    const cas = freshCas();
    const persistBundle = vi.fn<ProofSubstrate["persistBundle"]>(fakeSubstrate(true).persistBundle);
    const substrate = { ...fakeSubstrate(true), persistBundle };
    const outcome = await sealEvidence(
      { proofSubstrate: substrate, casByteStore: cas as never, store: sink },
      evidenceFixture(),
    );
    expect(outcome.status).toBe("sealed");
    if (outcome.status !== "sealed") throw new Error("unreachable");
    expect(outcome.inserted).toBe(true);
    expect(persistBundle).toHaveBeenCalledOnce();
    // Two CAS writes: the pre-seal artifact bytes then the final manifest bytes.
    expect(cas.put).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    // The stored bytes_digest is the CAS manifest bytes, not the bundle's own bytes.
    expect(calls[0]?.bytesDigest).toBe(SHA("e"));
    expect(calls[0]?.bundleId).toBe("bundle-1");
    expect(() => validateMergeTrainArtifact(outcome.artifact)).not.toThrow();
    expect(outcome.artifact.sealedBundle.rootSignatureHex).toBe("abcd");
  });

  it("FAILS CLOSED when the substrate cannot verify the bundle: no persist, no CAS write", async () => {
    const { sink, calls } = recordingSink();
    const cas = freshCas();
    const persistBundle = vi.fn<ProofSubstrate["persistBundle"]>(fakeSubstrate(false).persistBundle);
    const substrate = { ...fakeSubstrate(false), persistBundle };
    const outcome = await sealEvidence(
      { proofSubstrate: substrate, casByteStore: cas as never, store: sink },
      evidenceFixture(),
    );
    expect(outcome.status).toBe("verification_failed");
    // The gravest fail-open (a persisted bundle + artifact row) is what must NOT happen.
    expect(persistBundle).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

// ---- gatherEvidenceFromClient fail-closed arms over a fake query client -------------

interface FakeRows {
  land_groups?: unknown[];
  authority_decisions?: unknown[];
  authority_land_receipts?: unknown[];
  proof_root?: unknown[];
  land_group_members?: unknown[];
  release_instances?: unknown[];
  // Terminal-family events, dispatched by the event_type set the query asks for.
  formed?: unknown[];
  deploy?: unknown[];
  demo?: unknown[];
}

// The deploy/demo/formed terminal queries share one SQL shape (event_type = ANY), so
// dispatch on the parameter array (the requested event-type set) rather than SQL text.
function fakeClientWithEvents(rows: FakeRows) {
  return {
    query: async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
      if (sql.includes("FROM land_groups")) return { rows: rows.land_groups ?? [] };
      if (sql.includes("FROM authority_decisions")) return { rows: rows.authority_decisions ?? [] };
      if (sql.includes("FROM authority_land_receipts")) return { rows: rows.authority_land_receipts ?? [] };
      if (sql.includes("integration.proof_root.composed")) return { rows: rows.proof_root ?? [] };
      if (sql.includes("FROM land_group_members")) return { rows: rows.land_group_members ?? [] };
      if (sql.includes("FROM release_instances")) return { rows: rows.release_instances ?? [] };
      if (sql.includes("event_type = ANY")) {
        const types = (params?.[2] as string[]) ?? [];
        if (types.includes("merge.group.formed")) return { rows: rows.formed ?? [] };
        if (types.includes("deploy.verified")) return { rows: rows.deploy ?? [] };
        if (types.includes("demo.completed")) return { rows: rows.demo ?? [] };
      }
      return { rows: [] };
    },
  } as never;
}

const LINEAGE = { runId: "run-b", specId: "spec-b", projectId: "proj1", orgId: "org1" };
const COMPLETED = evidenceFixture().completed;

function happyRows(): FakeRows {
  return {
    land_groups: [
      { state: "completed", main_sha: "mainsha1", decision_id: "decision-node1-headsha", created_at: new Date() },
    ],
    authority_decisions: [
      {
        project_id: "proj1",
        integration_node_id: "node1",
        proof_root: `sha256:${"a".repeat(64)}`,
        head_sha: "headsha",
        expected_main_sha: "expmain",
        member_set_hash: "msh",
      },
    ],
    authority_land_receipts: [{ audit_id: "audit1", main_sha: "mainsha1" }],
    proof_root: [{ payload: { integrationNodeId: "node1", proofRoot: `sha256:${"a".repeat(64)}` } }],
    land_group_members: [
      { member_key: "mk-a", run_id: "run-a", spec_id: "spec-a", pr_number: "11", outcome: "landed" },
      { member_key: "mk-b", run_id: "run-b", spec_id: "spec-b", pr_number: null, outcome: "landed" },
    ],
    release_instances: [{ source_ref: "mainsha1", state: "live", environment: "production" }],
    formed: [{ event_type: "merge.group.formed", payload: { groupId: "lg1", memberKeys: ["mk-a", "mk-b"] } }],
    deploy: [
      {
        event_type: "deploy.verified",
        payload: { provider: "fly", appId: "app1", deploymentId: "dep1", url: "https://x", state: "live" },
      },
    ],
    demo: [
      { event_type: "demo.completed", payload: { surfaceKind: "web_url", behaviorCount: 3, passed: 3, failed: 0 } },
    ],
  };
}

const gather = (rows: FakeRows) => gatherEvidenceFromClient(fakeClientWithEvents(rows), LINEAGE, COMPLETED, "run-b");

describe("mq-15 gatherEvidenceFromClient", () => {
  it("returns full evidence when every bound input is exact", async () => {
    const evidence = await gather(happyRows());
    expect(evidence?.members).toHaveLength(2);
    expect(evidence?.decision.integration_node_id).toBe("node1");
  });

  it("fails closed on a cross-project authority decision", async () => {
    const rows = happyRows();
    rows.authority_decisions = [{ ...(rows.authority_decisions![0] as object), project_id: "other-project" }];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed when the decision head_sha ≠ the land authorizedSha (Finding 3)", async () => {
    const rows = happyRows();
    rows.authority_decisions = [{ ...(rows.authority_decisions![0] as object), head_sha: "different-head" }];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed on a missing proof_root.composed", async () => {
    const rows = happyRows();
    rows.proof_root = [];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed on a stale receipt (main sha drift)", async () => {
    const rows = happyRows();
    rows.authority_land_receipts = [{ audit_id: "audit1", main_sha: "other" }];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed on a wrong merge.group.formed group", async () => {
    const rows = happyRows();
    rows.formed = [
      { event_type: "merge.group.formed", payload: { groupId: "other-group", memberKeys: ["mk-a", "mk-b"] } },
    ];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed on a SUBSET member payload (Finding 1)", async () => {
    const rows = happyRows();
    const subset = { ...COMPLETED, memberKeys: ["mk-a"] };
    expect(await gatherEvidenceFromClient(fakeClientWithEvents(rows), LINEAGE, subset, "run-b")).toBeUndefined();
  });

  it("fails closed on a non-landed member (Finding 1)", async () => {
    const rows = happyRows();
    rows.land_group_members = [
      { member_key: "mk-a", run_id: "run-a", spec_id: "spec-a", pr_number: "11", outcome: "landed" },
      { member_key: "mk-b", run_id: "run-b", spec_id: "spec-b", pr_number: null, outcome: "reverted" },
    ];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed on an unsuccessful demo (a failed behavior)", async () => {
    const rows = happyRows();
    rows.demo = [
      { event_type: "demo.completed", payload: { surfaceKind: "web_url", behaviorCount: 3, passed: 2, failed: 1 } },
    ];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed when the NEWEST terminal demo is a failure (Finding 2)", async () => {
    const rows = happyRows();
    rows.demo = [{ event_type: "demo.failed", payload: {} }];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed when the NEWEST terminal deploy is a failure (Finding 2)", async () => {
    const rows = happyRows();
    rows.deploy = [{ event_type: "deploy.failed", payload: {} }];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed on a STALE deploy release for a prior SHA (Finding 2)", async () => {
    const rows = happyRows();
    rows.release_instances = [{ source_ref: "prior-sha", state: "live" }];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed when the deploy's release row is missing", async () => {
    const rows = happyRows();
    rows.release_instances = [];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed on an INTERMEDIATE (non-live) release state for the tip (Finding 2)", async () => {
    for (const state of ["built", "preview", "promoting"]) {
      const rows = happyRows();
      rows.release_instances = [{ source_ref: "mainsha1", state, environment: "production" }];
      expect(await gather(rows)).toBeUndefined();
    }
  });

  it("fails closed on a live but NON-production release environment (Finding 2)", async () => {
    const rows = happyRows();
    rows.release_instances = [{ source_ref: "mainsha1", state: "live", environment: "preview" }];
    expect(await gather(rows)).toBeUndefined();
  });

  it("fails closed on an empty-string member identity — no ingest/persist (Finding 3)", async () => {
    const rows = happyRows();
    rows.land_group_members = [
      { member_key: "mk-a", run_id: "run-a", spec_id: "spec-a", pr_number: "11", outcome: "landed" },
      { member_key: "mk-b", run_id: "", spec_id: "spec-b", pr_number: null, outcome: "landed" },
    ];
    expect(await gather(rows)).toBeUndefined();
  });
});

// ---- store read mappers over a fake client -----------------------------------------

describe("mq-15 PgMergeTrainArtifactStore reads", () => {
  const artifactRow = {
    id: "mta-lg1",
    land_group_id: "lg1",
    authority_decision_id: "decision-node1-headsha",
    integration_node_id: "node1",
    proof_root: `sha256:${"a".repeat(64)}`,
    receipt_main_sha: "mainsha1",
    deploy_deployment_id: "dep1",
    demo_surface_kind: "web_url",
    demo_behavior_count: 3,
    demo_passed: 3,
    bundle_digest: `sha256:${"b".repeat(64)}`,
    content_hash: `sha256:${"f".repeat(64)}`,
    created_at: new Date("2026-07-20T00:00:00Z"),
  };

  it("list() maps rows to summaries", async () => {
    const client = { query: async () => ({ rows: [artifactRow] }) } as never;
    const summaries = await PgMergeTrainArtifactStore.list(client, "org1", "proj1", 20);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.landGroupId).toBe("lg1");
    expect(summaries[0]?.createdAt).toBe("2026-07-20T00:00:00.000Z");
  });

  it("getByLandGroup() re-validates the stored manifest, returning undefined when absent", async () => {
    const empty = { query: async () => ({ rows: [] }) } as never;
    expect(await PgMergeTrainArtifactStore.getByLandGroup(empty, "org1", "proj1", "missing")).toBeUndefined();
  });

  it("getByLandGroup() throws on a corrupted persisted manifest (fail closed)", async () => {
    const corrupt = { query: async () => ({ rows: [{ manifest: { version: 1 } }] }) } as never;
    await expect(PgMergeTrainArtifactStore.getByLandGroup(corrupt, "org1", "proj1", "lg1")).rejects.toThrow(
      /invalid/iu,
    );
  });
});
