import { randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { CanonicalBody, Digest, ProofUnitKind } from "../contracts/cas.js";
import type { GateProofBundleV2, GateSectionKind, GateSectionVerdict } from "../contracts/gateProof.js";
import { GATE_SECTION_BODY_SCHEMAS, aggregateGateVerdict, orderSections } from "../contracts/gateProof.js";
import { batchArtifactDigestFor } from "./multiMemberAuthorityTypes.js";
import { loadGateProofRequirements, loadGateSectionDrafts } from "./gateProofBundleSectionsPg.js";
import type { GateProofBundleInput, GateProofBundleSealer, GateProofBundleStoreDeps } from "./gateProofBundleTypes.js";

/** Production V2 composer: validates real gate evidence, seals through SP-3, then projects it. */
export class PgGateProofBundleSealer implements GateProofBundleSealer {
  public constructor(
    private readonly pool: pg.Pool,
    private readonly deps: GateProofBundleStoreDeps,
  ) {}

  public async seal(input: GateProofBundleInput): Promise<GateProofBundleV2> {
    assertInput(input);
    await assertExactReadyNode(this.pool, input);
    const requirements = await loadGateProofRequirements(this.pool, input);
    const drafts = await loadGateSectionDrafts(this.pool, this.deps.proofSubstrate, input, requirements);
    const refs = await this.deps.proofSubstrate.ingestUnits({
      orgId: input.orgId,
      projectId: input.projectId,
      drafts: drafts.map((section) => section.draft),
      validateSectionBody,
    });
    if (refs.length !== drafts.length) throw new Error("gate proof unit ingestion returned an incomplete section set");
    const sections = sectionsFor(drafts, refs);
    const gateVerdict = aggregateGateVerdict(requirements.plan, sections);
    const artifactDigest = await persistExactArtifact(this.deps.cas, input);
    const sealedAt = new Date().toISOString();
    const sealed = await this.deps.proofSubstrate.constructBundle({
      orgId: input.orgId,
      projectId: input.projectId,
      members: refs,
      bindings: {
        integrationNodeId: input.nodeId,
        memberSetHash: input.memberSetHash,
        gateConfigHash: input.proofKeyInput.gateConfigHash,
        policyVersion: input.proofKeyInput.policyVersion,
        runnerImage: input.proofKeyInput.runnerImage,
        appEnvHash: input.proofKeyInput.appEnvHash,
        quarantineVersion: input.proofKeyInput.quarantineVersion,
        preparedHeadSha: input.headSha,
        jjTreeId: input.treeHash,
        artifactDigest,
        expectedMainSha: input.baseSha,
        nonce: randomUUID(),
        // These are sealed audit metadata only. V2 contains no time/lease comparison;
        // the same instant makes that explicit while satisfying the SP-3 record shape.
        issuedAt: sealedAt,
        expiresAt: sealedAt,
      },
    });
    await this.deps.proofSubstrate.persistBundle(sealed);
    const bundle: GateProofBundleV2 = {
      gateProofBundleId: gateProofBundleId(input.nodeId),
      proofBundleDigest: sealed.bundleDigest,
      proofRoot: sealed.proofRoot,
      integrationNodeId: input.nodeId,
      proofKeyInput: input.proofKeyInput,
      plan: requirements.plan,
      sections,
      runtimeBehaviorBindings: drafts.flatMap((draft) =>
        draft.runtimeBehaviorBinding === undefined ? [] : [draft.runtimeBehaviorBinding],
      ),
      gateVerdict,
    };
    await persistProjection(this.pool, input, bundle, sealed.bundleId);
    return bundle;
  }

  public async findExact(input: Omit<GateProofBundleInput, "nativeCi">): Promise<GateProofBundleV2 | undefined> {
    // Reuse is intentionally delegated to the same verifier the land authority uses. The
    // implementation lives in the read module to avoid a second interpretation of V2.
    const { readExactGateProofBundle } = await import("./gateProofBundleVerifyPg.js");
    return readExactGateProofBundle(this.pool, this.deps.proofSubstrate, input);
  }
}

/** Store the exact string that `batchArtifactDigestFor` hashes; no mutable ref can substitute. */
async function persistExactArtifact(
  cas: GateProofBundleStoreDeps["cas"],
  input: Pick<GateProofBundleInput, "orgId" | "headSha" | "treeHash">,
): Promise<Digest> {
  const bytes = new TextEncoder().encode(`tanren:merge-batch-artifact:v1\0${input.headSha}\0${input.treeHash}`);
  const artifact = await cas.put({
    orgId: input.orgId,
    bytes,
    mediaType: "application/vnd.tanren.integration-head.v1+text",
  });
  const expected = batchArtifactDigestFor(input.headSha, input.treeHash);
  if (artifact.digest !== expected)
    throw new Error("exact integration artifact CAS digest diverged from the sealed coordinate");
  return artifact.digest;
}

function sectionsFor(
  drafts: Awaited<ReturnType<typeof loadGateSectionDrafts>>,
  refs: readonly { readonly digest: GateSectionVerdict["unitDigests"][number] }[],
): readonly GateSectionVerdict[] {
  const grouped = new Map<GateSectionKind, GateSectionVerdict>();
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const ref = refs[index];
    if (draft === undefined || ref === undefined) throw new Error("gate proof section/ref cardinality diverged");
    const prior = grouped.get(draft.kind);
    if (prior === undefined) {
      grouped.set(draft.kind, { kind: draft.kind, required: true, verdict: draft.verdict, unitDigests: [ref.digest] });
      continue;
    }
    const verdict =
      prior.verdict === "failed" || draft.verdict === "failed"
        ? "failed"
        : prior.verdict === "unknown" || draft.verdict === "unknown"
          ? "unknown"
          : "passed";
    grouped.set(draft.kind, { ...prior, verdict, unitDigests: [...prior.unitDigests, ref.digest] });
  }
  return orderSections([...grouped.values()]);
}

function validateSectionBody(kind: ProofUnitKind, body: CanonicalBody): void {
  if (kind === "native_ci_tier" || kind === "native_ci_step") {
    GATE_SECTION_BODY_SCHEMAS.native_ci.parse(body);
    return;
  }
  if (kind === "runtime_behavior" || kind === "design_render" || kind === "artifact_provenance") {
    GATE_SECTION_BODY_SCHEMAS[kind].parse(body);
    return;
  }
  throw new TypeError(`proof unit kind '${kind}' cannot be a gate-proof section`);
}

async function persistProjection(
  pool: pg.Pool,
  input: GateProofBundleInput,
  bundle: GateProofBundleV2,
  proofBundleId: string,
): Promise<void> {
  await runWithOrgScope(pool, input.orgId, async (client) => {
    await client.query(`DELETE FROM gate_proof_bundle_sections WHERE org_id = $1 AND gate_proof_bundle_id = $2`, [
      input.orgId,
      bundle.gateProofBundleId,
    ]);
    await client.query(
      `INSERT INTO gate_proof_bundles
         (org_id, project_id, id, integration_node_id, gate_config_hash, policy_version, quarantine_version, proof_bundle_id, gate_verdict)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (org_id, id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         integration_node_id = EXCLUDED.integration_node_id,
         gate_config_hash = EXCLUDED.gate_config_hash,
         policy_version = EXCLUDED.policy_version,
         quarantine_version = EXCLUDED.quarantine_version,
         proof_bundle_id = EXCLUDED.proof_bundle_id,
         gate_verdict = EXCLUDED.gate_verdict`,
      [
        input.orgId,
        input.projectId,
        bundle.gateProofBundleId,
        input.nodeId,
        input.gateConfigHash,
        input.policyVersion,
        input.proofKeyInput.quarantineVersion,
        proofBundleId,
        bundle.gateVerdict,
      ],
    );
    let ordinal = 0;
    for (const section of bundle.sections) {
      for (const digest of section.unitDigests) {
        await client.query(
          `INSERT INTO gate_proof_bundle_sections
             (org_id, project_id, gate_proof_bundle_id, proof_bundle_id, proof_unit_digest, section_kind, ordinal, required)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
          [input.orgId, input.projectId, bundle.gateProofBundleId, proofBundleId, digest, section.kind, ordinal],
        );
        ordinal += 1;
      }
    }
  });
}

async function assertExactReadyNode(pool: pg.Pool, input: GateProofBundleInput): Promise<void> {
  const row = await runWithOrgScope(pool, input.orgId, async (client) => {
    const result = await client.query<{
      node_id: string;
      base_sha: string;
      head_sha: string | null;
      tree_hash: string | null;
      member_key: string;
      gate_config_hash: string;
      policy_version: string;
      status: string;
      members: unknown;
    }>(
      `SELECT node_id, base_sha, head_sha, tree_hash, member_key, gate_config_hash, policy_version, status, members
         FROM integration_nodes
        WHERE org_id = $1 AND project_id = $2 AND node_id = $3`,
      [input.orgId, input.projectId, input.nodeId],
    );
    return result.rows[0];
  });
  if (
    row === undefined ||
    row.status !== "ready" ||
    row.base_sha !== input.baseSha ||
    row.head_sha !== input.headSha ||
    row.tree_hash !== input.treeHash ||
    row.member_key !== input.memberSetHash ||
    row.gate_config_hash !== input.gateConfigHash ||
    row.policy_version !== input.policyVersion ||
    !sameMembers(row.members, input.members)
  ) {
    throw new Error(
      "cannot seal V2 gate proof: persisted integration node does not exactly match the native gate input",
    );
  }
}

function sameMembers(raw: unknown, expected: GateProofBundleInput["members"]): boolean {
  if (!Array.isArray(raw) || raw.length !== expected.length) return false;
  return raw.every((candidate, index) => {
    const member = expected[index];
    return (
      candidate !== null &&
      typeof candidate === "object" &&
      member !== undefined &&
      Reflect.get(candidate, "specId") === member.specId &&
      Reflect.get(candidate, "runId") === member.runId &&
      Reflect.get(candidate, "branch") === member.branch &&
      Reflect.get(candidate, "headSha") === member.headSha
    );
  });
}

function assertInput(input: GateProofBundleInput): void {
  const coordinates: readonly [string, unknown][] = [
    ["org_id", input.orgId],
    ["project_id", input.projectId],
    ["node_id", input.nodeId],
    ["base_sha", input.baseSha],
    ["head_sha", input.headSha],
    ["tree_hash", input.treeHash],
    ["member_set_hash", input.memberSetHash],
    ["gate_config_hash", input.gateConfigHash],
    ["policy_version", input.policyVersion],
    ["proof_member_key", input.proofKeyInput.memberKey],
    ["proof_gate_config_hash", input.proofKeyInput.gateConfigHash],
    ["proof_policy_version", input.proofKeyInput.policyVersion],
    ["proof_runner_image", input.proofKeyInput.runnerImage],
    ["proof_app_env_hash", input.proofKeyInput.appEnvHash],
    ["proof_quarantine_version", input.proofKeyInput.quarantineVersion],
  ];
  if (coordinates.some(([, value]) => typeof value !== "string" || value.trim() === "")) {
    throw new TypeError("V2 gate proof has an invalid binding coordinate");
  }
  if (
    input.nativeCi === null ||
    typeof input.nativeCi !== "object" ||
    typeof input.nativeCi.gateConfigHash !== "string" ||
    input.nativeCi.gateConfigHash.trim() === "" ||
    !isGateVerdict(input.nativeCi.verdict)
  ) {
    throw new TypeError("V2 gate proof has invalid native CI evidence");
  }
  if (input.gateConfigHash !== input.nativeCi.gateConfigHash) {
    throw new TypeError("V2 gate proof native CI config hash differs from the persisted integration node coordinate");
  }
  if (
    input.proofKeyInput.memberKey !== input.memberSetHash ||
    input.proofKeyInput.gateConfigHash !== input.gateConfigHash ||
    input.proofKeyInput.policyVersion !== input.policyVersion
  ) {
    throw new TypeError("V2 gate proof identity differs from the persisted integration node coordinate");
  }
  if (!Array.isArray(input.members) || input.members.length === 0 || !input.members.every(validMember)) {
    throw new TypeError("V2 gate proof refuses an invalid or empty integration member set");
  }
}

function validMember(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return ["specId", "runId", "branch", "headSha"].every((field) => {
    const candidate = Reflect.get(value, field);
    return typeof candidate === "string" && candidate.trim() !== "";
  });
}

function isGateVerdict(value: unknown): value is GateSectionVerdict["verdict"] {
  return value === "passed" || value === "failed" || value === "unknown";
}

export function gateProofBundleId(nodeId: string): string {
  return `gate_proof_bundle:${nodeId}`;
}
