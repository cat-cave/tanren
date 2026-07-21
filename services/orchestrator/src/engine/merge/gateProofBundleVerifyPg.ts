import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type {
  ProofBundleMemberRef,
  ProofBundleSealed,
  ProofSubstrate,
  ProofUnitKind,
  ProofUnitVerdict,
} from "../contracts/cas.js";
import { parseDigest } from "../contracts/cas.js";
import type { GateProofBundleV2, GateSectionKind, GateSectionVerdict } from "../contracts/gateProof.js";
import { aggregateGateVerdict, orderSections } from "../contracts/gateProof.js";
import { batchArtifactDigestFor } from "./multiMemberAuthorityTypes.js";
import { loadGateProofRequirements, requiredGateSections } from "./gateProofBundleSectionsPg.js";
import { gateProofBundleId } from "./gateProofBundleSealPg.js";
import type { GateProofBundleInput, GateProofBundleVerifier } from "./gateProofBundleTypes.js";

interface StoredBundleRow {
  gate_proof_bundle_id: string;
  gate_verdict: string;
  proof_bundle_id: string;
  bundle_digest: string;
  proof_root: string;
  bytes_digest: string;
  integration_node_id: string;
  gate_config_hash: string;
  policy_version: string;
  projection_quarantine_version: string;
  sealed_gate_config_hash: string | null;
  sealed_policy_version: string | null;
  runner_image: string | null;
  app_env_hash: string | null;
  quarantine_version: string | null;
  member_set_hash: string;
  prepared_head_sha: string;
  jj_tree_id: string;
  artifact_digest: string;
  expected_main_sha: string;
  node_members: unknown;
  signing_key_id: string;
  root_signature: Uint8Array;
  nonce: string;
  issued_at: Date | string;
  expires_at: Date | string;
  bundle_unit_id: string;
  proof_unit_digest: string;
  unit_kind: string;
  unit_verdict: string;
  subject_id: string;
  unit_ordinal: number;
  section_kind: string | null;
  section_required: boolean | null;
  section_ordinal: number | null;
}

/** The production-only reader shared by V2 reuse and pre-CAS authority revalidation. */
export class PgGateProofBundleVerifier implements GateProofBundleVerifier {
  public constructor(
    private readonly pool: pg.Pool,
    private readonly proofSubstrate: ProofSubstrate,
  ) {}

  public async verifyExact(input: Parameters<GateProofBundleVerifier["verifyExact"]>[0]): Promise<boolean> {
    const bundle = await readExactGateProofBundle(this.pool, this.proofSubstrate, input);
    return (
      bundle !== undefined &&
      bundle.gateProofBundleId === input.gateProofBundleId &&
      bundle.proofBundleDigest === input.proofBundleDigest &&
      bundle.proofRoot === input.proofRoot &&
      bundle.gateVerdict === "passed"
    );
  }
}

/** Return a V2 bundle only after its SP-3 seal and every exact section coordinate verify. */
export async function readExactGateProofBundle(
  pool: pg.Pool,
  proofSubstrate: ProofSubstrate,
  input: Omit<GateProofBundleInput, "nativeCi">,
): Promise<GateProofBundleV2 | undefined> {
  try {
    const requirements = await loadGateProofRequirements(pool, input);
    const rows = await readRows(pool, input);
    if (rows.length === 0) return undefined;
    const first = rows[0];
    if (
      first === undefined ||
      !sameBundleBinding(first, input) ||
      !rows.every((row) => sameProjection(row, first) && sameBundleBinding(row, input))
    ) {
      return undefined;
    }
    const sealed = sealedBundle(rows);
    const verification = await proofSubstrate.verify(sealed);
    if (!verification.valid) return undefined;
    const sections = sectionsFromRows(rows);
    if (!hasExactSections(rows, sections, input, requirements)) return undefined;
    const parsedGateVerdict = gateVerdict(first.gate_verdict);
    if (parsedGateVerdict !== aggregateGateVerdict(requirements.plan, sections)) return undefined;
    return {
      gateProofBundleId: first.gate_proof_bundle_id,
      proofBundleDigest: sealed.bundleDigest,
      proofRoot: sealed.proofRoot,
      integrationNodeId: input.nodeId,
      proofKeyInput: sealedProofKeyInput(first),
      plan: requirements.plan,
      sections,
      gateVerdict: parsedGateVerdict,
    };
  } catch {
    return undefined;
  }
}

async function readRows(pool: pg.Pool, input: Omit<GateProofBundleInput, "nativeCi">): Promise<StoredBundleRow[]> {
  return runWithOrgScope(pool, input.orgId, async (client) => {
    const result = await client.query<StoredBundleRow>(
      `SELECT g.id AS gate_proof_bundle_id, g.gate_verdict, g.proof_bundle_id,
              b.bundle_digest, b.proof_root, b.bytes_digest, b.integration_node_id, g.gate_config_hash, g.policy_version,
              g.quarantine_version AS projection_quarantine_version,
              b.gate_config_hash AS sealed_gate_config_hash, b.policy_version AS sealed_policy_version,
              b.runner_image, b.app_env_hash, b.quarantine_version,
              b.member_set_hash,
              b.prepared_head_sha, b.jj_tree_id, b.artifact_digest, b.expected_main_sha, n.members AS node_members,
              b.signing_key_id, b.root_signature, b.nonce, b.issued_at, b.expires_at,
              bu.id AS bundle_unit_id, bu.proof_unit_digest, pu.kind AS unit_kind, pu.verdict AS unit_verdict,
              pu.subject_id,
              bu.ordinal AS unit_ordinal, s.section_kind, s.required AS section_required, s.ordinal AS section_ordinal
         FROM gate_proof_bundles g
         JOIN proof_bundles b ON b.org_id = g.org_id AND b.id = g.proof_bundle_id
         JOIN integration_nodes n ON n.org_id = g.org_id AND n.node_id = g.integration_node_id
         JOIN proof_bundle_units bu ON bu.org_id = b.org_id AND bu.bundle_id = b.id
         JOIN proof_units pu ON pu.org_id = bu.org_id AND pu.proof_unit_digest = bu.proof_unit_digest
         LEFT JOIN gate_proof_bundle_sections s
           ON s.org_id = g.org_id AND s.gate_proof_bundle_id = g.id AND s.proof_bundle_id = b.id
          AND s.proof_unit_digest = bu.proof_unit_digest
        WHERE g.org_id = $1 AND g.project_id = $2 AND g.integration_node_id = $3
        ORDER BY bu.ordinal ASC`,
      [input.orgId, input.projectId, input.nodeId],
    );
    return result.rows;
  });
}

function sameBundleBinding(row: StoredBundleRow, input: Omit<GateProofBundleInput, "nativeCi">): boolean {
  return (
    row.gate_proof_bundle_id === gateProofBundleId(input.nodeId) &&
    row.integration_node_id === input.nodeId &&
    row.gate_config_hash === input.gateConfigHash &&
    row.policy_version === input.policyVersion &&
    row.projection_quarantine_version === input.proofKeyInput.quarantineVersion &&
    row.sealed_gate_config_hash === input.proofKeyInput.gateConfigHash &&
    row.sealed_policy_version === input.proofKeyInput.policyVersion &&
    row.runner_image === input.proofKeyInput.runnerImage &&
    row.app_env_hash === input.proofKeyInput.appEnvHash &&
    row.quarantine_version === input.proofKeyInput.quarantineVersion &&
    input.proofKeyInput.memberKey === input.memberSetHash &&
    input.proofKeyInput.gateConfigHash === input.gateConfigHash &&
    input.proofKeyInput.policyVersion === input.policyVersion &&
    row.member_set_hash === input.memberSetHash &&
    row.prepared_head_sha === input.headSha &&
    row.jj_tree_id === input.treeHash &&
    row.expected_main_sha === input.baseSha &&
    sameMembers(row.node_members, input.members) &&
    row.artifact_digest === batchArtifactDigestFor(input.headSha, input.treeHash)
  );
}

/** Every join row must describe the one projection and one sealed SP-3 bundle. */
function sameProjection(row: StoredBundleRow, first: StoredBundleRow): boolean {
  return (
    row.gate_proof_bundle_id === first.gate_proof_bundle_id &&
    row.proof_bundle_id === first.proof_bundle_id &&
    row.bundle_digest === first.bundle_digest &&
    row.proof_root === first.proof_root &&
    row.bytes_digest === first.bytes_digest &&
    row.integration_node_id === first.integration_node_id &&
    row.gate_config_hash === first.gate_config_hash &&
    row.policy_version === first.policy_version &&
    row.projection_quarantine_version === first.projection_quarantine_version &&
    row.sealed_gate_config_hash === first.sealed_gate_config_hash &&
    row.sealed_policy_version === first.sealed_policy_version &&
    row.runner_image === first.runner_image &&
    row.app_env_hash === first.app_env_hash &&
    row.quarantine_version === first.quarantine_version &&
    row.member_set_hash === first.member_set_hash &&
    row.prepared_head_sha === first.prepared_head_sha &&
    row.jj_tree_id === first.jj_tree_id &&
    row.artifact_digest === first.artifact_digest &&
    row.expected_main_sha === first.expected_main_sha &&
    sameRawMembers(row.node_members, first.node_members) &&
    row.signing_key_id === first.signing_key_id &&
    row.nonce === first.nonce
  );
}

function sealedBundle(rows: readonly StoredBundleRow[]): ProofBundleSealed {
  const first = requiredFirst(rows);
  const members = rows.map((row) => memberFrom(row));
  return {
    bundleId: first.proof_bundle_id,
    bundleDigest: parseDigest(first.bundle_digest),
    proofRoot: parseDigest(first.proof_root),
    members,
    bindings: {
      integrationNodeId: requiredText(first.integration_node_id, "integration_node_id"),
      memberSetHash: requiredText(first.member_set_hash, "member_set_hash"),
      gateConfigHash: optionalText(first.sealed_gate_config_hash, "sealed_gate_config_hash"),
      policyVersion: optionalText(first.sealed_policy_version, "sealed_policy_version"),
      runnerImage: optionalText(first.runner_image, "runner_image"),
      appEnvHash: optionalText(first.app_env_hash, "app_env_hash"),
      quarantineVersion: optionalText(first.quarantine_version, "quarantine_version"),
      preparedHeadSha: requiredText(first.prepared_head_sha, "prepared_head_sha"),
      jjTreeId: requiredText(first.jj_tree_id, "jj_tree_id"),
      artifactDigest: parseDigest(first.artifact_digest),
      expectedMainSha: requiredText(first.expected_main_sha, "expected_main_sha"),
      nonce: requiredText(first.nonce, "nonce"),
      issuedAt: timestampText(first.issued_at, "issued_at"),
      expiresAt: timestampText(first.expires_at, "expires_at"),
    },
    bytesDigest: parseDigest(first.bytes_digest),
    signingKeyId: requiredText(first.signing_key_id, "signing_key_id"),
    rootSignature: requiredBytes(first.root_signature, "root_signature"),
  };
}

function sealedProofKeyInput(row: StoredBundleRow): GateProofBundleV2["proofKeyInput"] {
  return {
    memberKey: requiredText(row.member_set_hash, "member_set_hash"),
    gateConfigHash: requiredNullableText(row.sealed_gate_config_hash, "sealed_gate_config_hash"),
    policyVersion: requiredNullableText(row.sealed_policy_version, "sealed_policy_version"),
    runnerImage: requiredNullableText(row.runner_image, "runner_image"),
    appEnvHash: requiredNullableText(row.app_env_hash, "app_env_hash"),
    quarantineVersion: requiredNullableText(row.quarantine_version, "quarantine_version"),
  };
}

function memberFrom(row: StoredBundleRow): ProofBundleMemberRef {
  return {
    bundleUnitId: requiredText(row.bundle_unit_id, "bundle_unit_id"),
    unitDigest: parseDigest(row.proof_unit_digest),
    kind: proofUnitKind(row.unit_kind),
    verdict: proofUnitVerdict(row.unit_verdict),
    ordinal: nonnegativeInt(row.unit_ordinal, "unit_ordinal"),
  };
}

function sectionsFromRows(rows: readonly StoredBundleRow[]): readonly GateSectionVerdict[] {
  const grouped = new Map<GateSectionKind, GateSectionVerdict>();
  for (const row of rows) {
    if (row.section_kind === null || row.section_required !== true || row.section_ordinal === null) continue;
    const kind = sectionKind(row.section_kind);
    const verdict = gateVerdictFromUnit(row.unit_verdict);
    const digest = parseDigest(row.proof_unit_digest);
    const previous = grouped.get(kind);
    if (previous === undefined) {
      grouped.set(kind, { kind, required: true, verdict, unitDigests: [digest] });
      continue;
    }
    grouped.set(kind, {
      ...previous,
      verdict: mergeVerdict(previous.verdict, verdict),
      unitDigests: [...previous.unitDigests, digest],
    });
  }
  return orderSections([...grouped.values()]);
}

function hasExactSections(
  rows: readonly StoredBundleRow[],
  sections: readonly GateSectionVerdict[],
  input: Omit<GateProofBundleInput, "nativeCi">,
  requirements: Awaited<ReturnType<typeof loadGateProofRequirements>>,
): boolean {
  const expected = requiredGateSections(input, requirements);
  if (rows.length !== expected.length || sections.some((section) => !section.required)) return false;
  const actual = rows.map((row) => {
    if (row.section_kind === null || row.section_required !== true || row.section_ordinal === null) return null;
    return { kind: sectionKind(requiredText(row.section_kind, "section_kind")), subjectId: subjectFor(row) };
  });
  if (actual.some((section) => section === null)) return false;
  const expectedKeys = expected.map((section) => sectionKey(section)).sort();
  const actualKeys = actual.flatMap((section) => (section === null ? [] : [sectionKey(section)])).sort();
  return expectedKeys.length === actualKeys.length && expectedKeys.every((key, index) => key === actualKeys[index]);
}

function subjectFor(row: StoredBundleRow): string {
  const kind = sectionKind(requiredNullableText(row.section_kind, "section_kind"));
  const unitKind = proofUnitKind(row.unit_kind);
  if (
    (kind === "native_ci" && unitKind !== "native_ci_tier") ||
    (kind === "runtime_behavior" && unitKind !== "runtime_behavior") ||
    (kind === "design_render" && unitKind !== "design_render") ||
    kind === "artifact_provenance"
  ) {
    throw new TypeError("gate section kind does not match its sealed proof-unit kind");
  }
  return requiredTextFromUnit(row);
}

function requiredTextFromUnit(row: StoredBundleRow): string {
  // The proof-unit subject is intentionally selected in the same query rather than inferred
  // from its digest. A digest alone cannot prove which required member it represents.
  return requiredText(row.subject_id, "proof unit subject_id");
}

function sectionKey(section: { readonly kind: GateSectionKind; readonly subjectId: string }): string {
  return `${section.kind}\u0000${section.subjectId}`;
}

/** Ordered full-member equality is separate from the member-set hash: no collision/loose set may reuse a V2 seal. */
function sameMembers(raw: unknown, expected: GateProofBundleInput["members"]): boolean {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length !== expected.length) return false;
  return raw.every((candidate, index) => {
    const member = expected[index];
    return (
      candidate !== null &&
      typeof candidate === "object" &&
      member !== undefined &&
      typeof member.specId === "string" &&
      member.specId.trim() !== "" &&
      typeof member.runId === "string" &&
      member.runId.trim() !== "" &&
      typeof member.branch === "string" &&
      member.branch.trim() !== "" &&
      typeof member.headSha === "string" &&
      member.headSha.trim() !== "" &&
      Reflect.get(candidate, "specId") === member.specId &&
      Reflect.get(candidate, "runId") === member.runId &&
      Reflect.get(candidate, "branch") === member.branch &&
      Reflect.get(candidate, "headSha") === member.headSha
    );
  });
}

function sameRawMembers(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((member, index) => {
    const candidate = right[index];
    return (
      member !== null &&
      typeof member === "object" &&
      candidate !== null &&
      typeof candidate === "object" &&
      Reflect.get(member, "specId") === Reflect.get(candidate, "specId") &&
      Reflect.get(member, "runId") === Reflect.get(candidate, "runId") &&
      Reflect.get(member, "branch") === Reflect.get(candidate, "branch") &&
      Reflect.get(member, "headSha") === Reflect.get(candidate, "headSha")
    );
  });
}

function requiredFirst<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new TypeError("sealed bundle has no proof-unit members");
  return value;
}

function gateVerdictFromUnit(value: string): GateSectionVerdict["verdict"] {
  const verdict = proofUnitVerdict(value);
  return verdict === "passed" ? "passed" : verdict === "failed" ? "failed" : "unknown";
}

function mergeVerdict(
  left: GateSectionVerdict["verdict"],
  right: GateSectionVerdict["verdict"],
): GateSectionVerdict["verdict"] {
  if (left === "failed" || right === "failed") return "failed";
  return left === "unknown" || right === "unknown" ? "unknown" : "passed";
}

function gateVerdict(value: string): GateProofBundleV2["gateVerdict"] {
  if (value === "passed" || value === "failed" || value === "unknown") return value;
  throw new TypeError(`unknown gate verdict '${value}'`);
}

function sectionKind(value: string): GateSectionKind {
  if (
    value === "native_ci" ||
    value === "runtime_behavior" ||
    value === "design_render" ||
    value === "artifact_provenance"
  )
    return value;
  throw new TypeError(`unknown gate section kind '${value}'`);
}

function proofUnitKind(value: string): ProofUnitKind {
  if (
    value === "native_ci_tier" ||
    value === "native_ci_step" ||
    value === "test" ||
    value === "runtime_behavior" ||
    value === "design_render" ||
    value === "artifact_provenance" ||
    value === "audit_rule" ||
    value === "security_finding"
  ) {
    return value;
  }
  throw new TypeError(`unknown proof-unit kind '${value}'`);
}

function proofUnitVerdict(value: string): ProofUnitVerdict {
  if (value === "passed" || value === "failed" || value === "unknown") return value;
  throw new TypeError(`unknown proof-unit verdict '${value}'`);
}

function requiredText(value: string, field: string): string {
  if (value.trim() === "") throw new TypeError(`${field} must be non-blank`);
  return value;
}

function requiredNullableText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a non-blank string`);
  return requiredText(value, field);
}

function optionalText(value: string | null, field: string): string | undefined {
  if (value === null) return undefined;
  return requiredText(value, field);
}

function requiredBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new TypeError(`${field} must be non-empty binary data`);
  }
  return value;
}

function timestampText(value: Date | string, field: string): string {
  const result = value instanceof Date ? value.toISOString() : value;
  return requiredText(result, field);
}

function nonnegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a nonnegative integer`);
  return value;
}
