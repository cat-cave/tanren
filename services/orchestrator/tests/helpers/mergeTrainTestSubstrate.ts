// A REAL-PG test ProofSubstrate for the mq-15 RLS proof — a test fixture, NOT a production
// signer (the doctrine forbids mq-15 adding one; production injects the sole SP-3 substrate).
// It writes real cas_artifacts / proof_units / proof_bundles rows under org scope so every FK
// holds, and HMAC-signs the root so `verify` is meaningful (a tampered root/signature fails).

import { createHash, createHmac } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type { Pool } from "pg";
import {
  type BundleBindings,
  canonicalJson,
  type Digest,
  parseDigest,
  type ProofBundleRef,
  type ProofBundleSealed,
  type ProofSubstrate,
  type ProofUnitDraft,
  type ProofUnitRef,
} from "../../src/engine/contracts/cas.js";
import type { PgCasByteStore } from "../../src/engine/cas/pgCasByteStore.js";

export const MQ15_TEST_HMAC_KEY = "mq15-test-signing-key";

export class TestProofSubstrate implements ProofSubstrate {
  private readonly scope = new Map<string, { orgId: string; projectId: string }>();
  constructor(
    private readonly pool: Pool,
    private readonly cas: PgCasByteStore,
  ) {}

  private digestOf(value: unknown): Digest {
    return parseDigest(
      `sha256:${createHash("sha256")
        .update(canonicalJson(value as never))
        .digest("hex")}`,
    );
  }

  async ingestUnits(input: {
    orgId: string;
    projectId: string;
    drafts: readonly ProofUnitDraft[];
  }): Promise<readonly ProofUnitRef[]> {
    const refs: ProofUnitRef[] = [];
    for (const draft of input.drafts) {
      const bytes = new TextEncoder().encode(
        canonicalJson({ kind: draft.kind, subjectId: draft.subjectId, verdict: draft.verdict, body: draft.body }),
      );
      const ref = await this.cas.put({ orgId: input.orgId, bytes, mediaType: "application/json" });
      await runWithOrgScope(this.pool, input.orgId, (client) =>
        client.query(
          `INSERT INTO proof_units (org_id, project_id, proof_unit_digest, kind, verdict, subject_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id, proof_unit_digest) DO NOTHING`,
          [input.orgId, input.projectId, ref.digest, draft.kind, draft.verdict, draft.subjectId],
        ),
      );
      refs.push({ digest: ref.digest, kind: draft.kind, verdict: draft.verdict });
    }
    return refs;
  }

  computeRoot(members: readonly ProofUnitRef[]): Digest {
    return this.digestOf(members.map((m) => m.digest));
  }

  async seal(input: { proofRoot: Digest; bindings: BundleBindings }) {
    return { signingKeyId: MQ15_TEST_HMAC_KEY, rootSignature: this.sign(input.proofRoot, input.bindings) };
  }

  private sign(proofRoot: Digest, bindings: BundleBindings): Uint8Array {
    return new Uint8Array(
      createHmac("sha256", MQ15_TEST_HMAC_KEY)
        .update(canonicalJson({ bindings, proofRoot } as never))
        .digest(),
    );
  }

  async constructBundle(input: {
    orgId: string;
    projectId: string;
    members: readonly ProofUnitRef[];
    bindings: BundleBindings;
  }): Promise<ProofBundleSealed> {
    const proofRoot = this.computeRoot(input.members);
    const bundleBytes = new TextEncoder().encode(canonicalJson({ bindings: input.bindings, proofRoot } as never));
    const bytesRef = await this.cas.put({ orgId: input.orgId, bytes: bundleBytes, mediaType: "application/json" });
    const bundleId = `bundle-${input.bindings.nonce}`;
    this.scope.set(bundleId, { orgId: input.orgId, projectId: input.projectId });
    return {
      bundleId,
      bundleDigest: this.digestOf({ bindings: input.bindings, bundleId, proofRoot, bytesDigest: bytesRef.digest }),
      proofRoot,
      members: input.members.map((m, ordinal) => ({
        bundleUnitId: `${bundleId}-${ordinal}`,
        unitDigest: m.digest,
        kind: m.kind,
        verdict: m.verdict,
        ordinal,
      })),
      bindings: input.bindings,
      bytesDigest: bytesRef.digest,
      signingKeyId: MQ15_TEST_HMAC_KEY,
      rootSignature: this.sign(proofRoot, input.bindings),
    };
  }

  async verify(bundle: ProofBundleSealed) {
    const expected = Buffer.from(this.sign(bundle.proofRoot, bundle.bindings));
    const actual = Buffer.from(bundle.rootSignature);
    const valid = bundle.members.length > 0 && expected.equals(actual);
    return valid ? { valid: true } : { valid: false, reason: "signature mismatch" };
  }

  async persistBundle(bundle: ProofBundleSealed): Promise<ProofBundleRef> {
    const scope = this.scope.get(bundle.bundleId);
    if (scope === undefined) throw new Error("unknown bundle scope");
    const b = bundle.bindings;
    await runWithOrgScope(this.pool, scope.orgId, async (client) => {
      await client.query(
        `INSERT INTO proof_bundles
           (org_id, id, project_id, bundle_digest, proof_root, bytes_digest, integration_node_id, member_set_hash,
            prepared_head_sha, jj_tree_id, artifact_digest, expected_main_sha, signing_key_id, root_signature, nonce,
            issued_at, expires_at, gate_config_hash, policy_version, runner_image, app_env_hash, quarantine_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (org_id, id) DO NOTHING`,
        [
          scope.orgId,
          bundle.bundleId,
          scope.projectId,
          bundle.bundleDigest,
          bundle.proofRoot,
          bundle.bytesDigest,
          b.integrationNodeId,
          b.memberSetHash,
          b.preparedHeadSha,
          b.jjTreeId,
          b.artifactDigest,
          b.expectedMainSha,
          bundle.signingKeyId,
          Buffer.from(bundle.rootSignature),
          b.nonce,
          b.issuedAt,
          b.expiresAt,
          b.gateConfigHash ?? null,
          b.policyVersion ?? null,
          b.runnerImage ?? null,
          b.appEnvHash ?? null,
          b.quarantineVersion ?? null,
        ],
      );
      for (const member of bundle.members) {
        await client.query(
          `INSERT INTO proof_bundle_units (org_id, id, project_id, bundle_id, proof_unit_digest, ordinal)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id, id) DO NOTHING`,
          [scope.orgId, member.bundleUnitId, scope.projectId, bundle.bundleId, member.unitDigest, member.ordinal],
        );
      }
    });
    return {
      bundleId: bundle.bundleId,
      bundleDigest: bundle.bundleDigest,
      proofRoot: bundle.proofRoot,
      bytesDigest: bundle.bytesDigest,
      members: bundle.members,
    };
  }
}
