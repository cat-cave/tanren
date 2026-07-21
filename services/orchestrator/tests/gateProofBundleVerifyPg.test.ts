import { describe, expect, it } from "vitest";
import type { Digest, ProofSubstrate } from "../src/engine/contracts/cas.js";
import type { GateProofBundleInput } from "../src/engine/merge/gateProofBundleTypes.js";
import { PgGateProofBundleSealer } from "../src/engine/merge/gateProofBundleSealPg.js";
import { PgGateProofBundleVerifier, readExactGateProofBundle } from "../src/engine/merge/gateProofBundleVerifyPg.js";
import { batchArtifactDigestFor } from "../src/engine/merge/multiMemberAuthorityTypes.js";

const BUNDLE_DIGEST = `sha256:${"a".repeat(64)}` as Digest;
const PROOF_ROOT = `sha256:${"b".repeat(64)}` as Digest;
const BYTES_DIGEST = `sha256:${"c".repeat(64)}` as Digest;
const UNIT_DIGEST = `sha256:${"d".repeat(64)}` as Digest;

const input: Omit<GateProofBundleInput, "nativeCi"> = {
  orgId: "org_v2_unit",
  projectId: "project_v2_unit",
  nodeId: "node_v2_unit",
  baseSha: "base_v2_unit",
  headSha: "head_v2_unit",
  treeHash: "tree_v2_unit",
  memberSetHash: "member-set-v2-unit",
  members: [{ specId: "spec_v2_unit", runId: "run_v2_unit", branch: "v2-unit", headSha: "member_v2_unit" }],
  gateConfigHash: "gate-config-v2-unit",
  policyVersion: "policy-v2-unit",
  proofKeyInput: {
    memberKey: "member-set-v2-unit",
    gateConfigHash: "gate-config-v2-unit",
    policyVersion: "policy-v2-unit",
    runnerImage: "runner-v2-unit",
    appEnvHash: "env-v2-unit",
    quarantineVersion: "quarantine-v2-unit",
  },
};

type StoredRow = Record<string, unknown>;

class RecordingClient {
  public constructor(private readonly bundleRows: readonly StoredRow[]) {}

  public async query<T>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes("SELECT config FROM projects")) return { rows: [{ config: { version: 1 } } as T] };
    if (sql.includes("SELECT project_id FROM runs")) return { rows: [] };
    if (sql.includes("FROM gate_proof_bundles g")) return { rows: this.bundleRows as T[] };
    return { rows: [] };
  }

  public release(): void {}
}

class RecordingPool {
  private readonly client: RecordingClient;

  public constructor(storedRows: readonly StoredRow[]) {
    this.client = new RecordingClient(storedRows);
  }

  public async connect(): Promise<RecordingClient> {
    return this.client;
  }
}

function unreachable(): never {
  throw new Error("this verifier fixture only permits the proof verification operation");
}

function verifiedProofSubstrate(): { readonly substrate: ProofSubstrate; readonly verifyCalls: () => number } {
  let calls = 0;
  return {
    substrate: {
      ingestUnits: async () => unreachable(),
      computeRoot: () => BUNDLE_DIGEST,
      seal: async () => unreachable(),
      constructBundle: async () => unreachable(),
      verify: async () => {
        calls += 1;
        return { valid: true };
      },
      persistBundle: async () => unreachable(),
    },
    verifyCalls: () => calls,
  };
}

function rows(section?: { readonly required: boolean; readonly kind: string | null }) {
  const gateSection = section ?? { required: true, kind: "native_ci" };
  return [
    {
      gate_proof_bundle_id: `gate_proof_bundle:${input.nodeId}`,
      gate_verdict: "passed",
      proof_bundle_id: "sp3-bundle-v2-unit",
      bundle_digest: BUNDLE_DIGEST,
      proof_root: PROOF_ROOT,
      bytes_digest: BYTES_DIGEST,
      integration_node_id: input.nodeId,
      gate_config_hash: input.gateConfigHash,
      policy_version: input.policyVersion,
      projection_quarantine_version: input.proofKeyInput.quarantineVersion,
      sealed_gate_config_hash: input.proofKeyInput.gateConfigHash,
      sealed_policy_version: input.proofKeyInput.policyVersion,
      runner_image: input.proofKeyInput.runnerImage,
      app_env_hash: input.proofKeyInput.appEnvHash,
      quarantine_version: input.proofKeyInput.quarantineVersion,
      member_set_hash: input.memberSetHash,
      prepared_head_sha: input.headSha,
      jj_tree_id: input.treeHash,
      artifact_digest: batchArtifactDigestFor(input.headSha, input.treeHash),
      expected_main_sha: input.baseSha,
      node_members: input.members,
      signing_key_id: "ed25519:unit",
      root_signature: new Uint8Array([1]),
      nonce: "nonce-v2-unit",
      issued_at: "2026-07-21T00:00:00.000Z",
      expires_at: "2026-07-21T00:00:00.000Z",
      bundle_unit_id: "bundle-unit-v2-unit",
      proof_unit_digest: UNIT_DIGEST,
      unit_kind: "native_ci_tier",
      unit_verdict: "passed",
      subject_id: `native_ci:${input.nodeId}`,
      unit_ordinal: 0,
      section_kind: gateSection.kind,
      section_required: gateSection.required,
      section_ordinal: gateSection.kind === null ? null : 0,
    },
  ];
}

describe("PgGateProofBundleVerifier — DB-free exact V2 fail-closed arms", () => {
  it("returns the same sealed root only for its exact native section and current config/policy coordinate", async () => {
    const proof = verifiedProofSubstrate();
    const pool = new RecordingPool(rows());
    const bundle = await readExactGateProofBundle(pool as never, proof.substrate, input);
    expect(bundle).toMatchObject({
      gateProofBundleId: `gate_proof_bundle:${input.nodeId}`,
      proofBundleDigest: BUNDLE_DIGEST,
      proofRoot: PROOF_ROOT,
      gateVerdict: "passed",
      sections: [{ kind: "native_ci", verdict: "passed", unitDigests: [UNIT_DIGEST] }],
    });
    expect(proof.verifyCalls()).toBe(1);

    const verifier = new PgGateProofBundleVerifier(pool as never, proof.substrate);
    await expect(
      verifier.verifyExact({
        ...input,
        gateProofBundleId: `gate_proof_bundle:${input.nodeId}`,
        proofBundleDigest: BUNDLE_DIGEST,
        proofRoot: PROOF_ROOT,
      }),
    ).resolves.toBe(true);
  });

  it("blocks before proof verification when a mutable node config cannot match the sealed V2 projection", async () => {
    const proof = verifiedProofSubstrate();
    const pool = new RecordingPool(rows());
    await expect(
      readExactGateProofBundle(pool as never, proof.substrate, { ...input, gateConfigHash: "different-config" }),
    ).resolves.toBeUndefined();
    expect(proof.verifyCalls()).toBe(0);
  });

  it("rejects a cryptographically valid bundle when any sealed proof-reuse component drifts", async () => {
    const proof = verifiedProofSubstrate();
    const pool = new RecordingPool(rows());
    await expect(
      readExactGateProofBundle(pool as never, proof.substrate, {
        ...input,
        proofKeyInput: { ...input.proofKeyInput, quarantineVersion: "quarantine-drifted-at-land" },
      }),
    ).resolves.toBeUndefined();
    expect(proof.verifyCalls()).toBe(0);
  });

  it("blocks a cryptographically valid bundle if its required native section projection is missing", async () => {
    const proof = verifiedProofSubstrate();
    const pool = new RecordingPool(rows({ required: false, kind: null }));
    await expect(readExactGateProofBundle(pool as never, proof.substrate, input)).resolves.toBeUndefined();
    expect(proof.verifyCalls()).toBe(1);
  });

  it("rejects malformed native evidence before a database or CAS side effect", async () => {
    const proof = verifiedProofSubstrate();
    let connections = 0;
    const pool = {
      connect: async () => {
        connections += 1;
        return new RecordingClient([]);
      },
    };
    const sealer = new PgGateProofBundleSealer(pool as never, {
      proofSubstrate: proof.substrate,
      cas: { put: async () => unreachable() },
    });
    const malformed: GateProofBundleInput = {
      ...input,
      nativeCi: {
        gateConfigHash: "",
        tiers: [],
        steps: [],
        junit: { total: 0, failures: 0, skipped: 0 },
        verdict: "passed",
      },
    };

    await expect(sealer.seal(malformed)).rejects.toThrow("invalid native CI evidence");
    expect(connections).toBe(0);
    expect(proof.verifyCalls()).toBe(0);
  });
});
