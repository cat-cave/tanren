import { runWithOrgScope } from "@tanren/db";
import { contentDigestOf } from "../contracts/cas.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import { DesignContractStore } from "../repositories/designContracts.js";
import { outputOnlyWatchdog } from "../ssh/activityWatchdog.js";
import { quoteSshShellArg } from "../ssh/command.js";
import {
  FRAGMENT_EVIDENCE_MANIFEST_PATH,
  FragmentEvidenceManifestV1Schema,
  type FragmentEvidenceManifestV1,
} from "../templates/fragments/fragmentEvidenceContract.js";
import { parseFragmentBehaviorManifest } from "../templates/fragments/resolveFragmentEvidenceForBatch.js";
import type pg from "pg";

/** Repository-controlled proof manifests are small declarative artifacts, not arbitrary blobs. */
export const MAX_EAGER_PROOF_ARTIFACT_BYTES = 64 * 1024;
const MAX_BASE64_ARTIFACT_OUTPUT_BYTES = MAX_EAGER_PROOF_ARTIFACT_BYTES * 2;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface EagerProofArtifacts {
  readonly designContractStamp: string;
  readonly designContractDigest: string;
  readonly behaviorManifestDigest: string;
  readonly fragmentEvidenceDigest: string;
  readonly fragmentEvidenceManifest: FragmentEvidenceManifestV1;
}

export async function resolveEagerProofArtifacts(input: {
  readonly pool: pg.Pool;
  readonly ssh: CommandSubstrate;
  readonly orgId: string;
  readonly projectId: string;
  readonly target: RunnerHandle;
  readonly workspacePath: string;
  /** The exact jj-local bookmark and exported Git object materialized for this proof. */
  readonly integration: { readonly ref: string; readonly headSha: string; readonly treeHash: string };
}): Promise<EagerProofArtifacts> {
  const design = await runWithOrgScope(input.pool, input.orgId, (client) =>
    DesignContractStore.getLatestState(client, input.projectId, { kind: "operator" }),
  );
  if (design.kind === "absent") throw new Error("eager DesignContract artifact is unavailable");
  if (design.kind === "corrupt") throw design.error;
  const designContractDigest = contentDigestOf(new TextEncoder().encode(JSON.stringify(design.record.rawContract)));
  assertIntegrationIdentity(input.integration);
  await verifyMaterializedIdentity(input);
  const evidenceBytes = await readMaterializedFile(input, FRAGMENT_EVIDENCE_MANIFEST_PATH);
  if (evidenceBytes === undefined) throw new Error("eager fragment evidence manifest is unavailable");
  const evidence = decodeArtifactUtf8(evidenceBytes, "fragment evidence manifest");
  const evidenceManifest = parseJson(FragmentEvidenceManifestV1Schema, evidence);
  if (evidenceManifest === undefined) throw new Error("eager fragment evidence manifest is malformed");
  if (evidenceManifest.evidence.behaviorManifest.path !== ".tanren/behavior-manifest.json") {
    throw new Error("eager behavior-manifest path does not match the validated evidence contract");
  }
  const manifestBytes = await readMaterializedFile(input, evidenceManifest.evidence.behaviorManifest.path);
  if (manifestBytes === undefined) throw new Error("eager behavior-manifest artifact is unavailable");
  const manifest = decodeArtifactUtf8(manifestBytes, "behavior-manifest");
  if (parseFragmentBehaviorManifest(manifest) === undefined)
    throw new Error("eager behavior-manifest artifact is malformed");
  const behaviorManifestDigest = contentDigestOf(manifestBytes);
  return {
    designContractStamp: `v${design.record.version}:${designContractDigest}`,
    designContractDigest,
    behaviorManifestDigest,
    fragmentEvidenceDigest: evidenceManifest.evidence.contentDigest,
    fragmentEvidenceManifest: evidenceManifest,
  };
}

function assertIntegrationIdentity(identity: {
  readonly ref: string;
  readonly headSha: string;
  readonly treeHash: string;
}): void {
  if (
    identity.ref.trim() === "" ||
    !/^[0-9a-f]{40}$/u.test(identity.headSha) ||
    !/^[0-9a-f]{40}$/u.test(identity.treeHash)
  ) {
    throw new Error("eager materialized integration identity is invalid");
  }
}

async function verifyMaterializedIdentity(input: Parameters<typeof resolveEagerProofArtifacts>[0]): Promise<void> {
  const observed = await input.ssh.run(input.target, {
    cwd: input.workspacePath,
    command: `git rev-parse ${quoteSshShellArg(input.integration.ref)} ${quoteSshShellArg(`${input.integration.ref}^{tree}`)}`,
    watchdog: outputOnlyWatchdog(),
  });
  const [headSha, treeHash, ...extra] = observed.stdout.trim().split("\n");
  if (
    observed.failure !== undefined ||
    observed.stalled === true ||
    observed.exitCode !== 0 ||
    extra.length > 0 ||
    headSha !== input.integration.headSha ||
    treeHash !== input.integration.treeHash
  ) {
    throw new Error("eager materialized integration identity does not match the exported ref");
  }
}

async function readMaterializedFile(
  input: Parameters<typeof resolveEagerProofArtifacts>[0],
  path: string,
): Promise<Uint8Array | undefined> {
  const object = `${input.integration.headSha}:${path}`;
  const sizeResult = await input.ssh.run(input.target, {
    cwd: input.workspacePath,
    command: `git cat-file -s ${quoteSshShellArg(object)}`,
    watchdog: outputOnlyWatchdog(),
  });
  if (sizeResult.failure !== undefined || sizeResult.stalled === true || sizeResult.exitCode !== 0) return undefined;
  const sizeText = sizeResult.stdout.trim();
  if (!/^\d+$/u.test(sizeText)) return undefined;
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) return undefined;
  if (size > MAX_EAGER_PROOF_ARTIFACT_BYTES) {
    throw new Error(`eager artifact ${path} exceeds ${MAX_EAGER_PROOF_ARTIFACT_BYTES}-byte limit`);
  }

  // The size preflight happens before the blob command, so the SSH substrate never
  // accumulates an unbounded repository-controlled artifact. Base64 keeps the raw
  // bytes lossless across the substrate's string-shaped stdout contract.
  const result = await input.ssh.run(input.target, {
    cwd: input.workspacePath,
    command: `git show ${quoteSshShellArg(object)} | base64`,
    watchdog: outputOnlyWatchdog(),
  });
  if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) return undefined;
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_BASE64_ARTIFACT_OUTPUT_BYTES) {
    throw new Error(`eager artifact ${path} exceeds ${MAX_EAGER_PROOF_ARTIFACT_BYTES}-byte limit`);
  }
  const encoded = result.stdout.replaceAll(/[\r\n]/gu, "");
  if (!BASE64_PATTERN.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.byteLength === size ? bytes : undefined;
}

function decodeArtifactUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`eager ${label} artifact is not valid UTF-8`);
  }
}

function parseJson<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: string,
): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
