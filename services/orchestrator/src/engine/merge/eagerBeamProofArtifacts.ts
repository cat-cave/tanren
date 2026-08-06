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
  const evidence = await readMaterializedFile(input, FRAGMENT_EVIDENCE_MANIFEST_PATH);
  if (evidence === undefined) throw new Error("eager fragment evidence manifest is unavailable");
  const evidenceManifest = parseJson(FragmentEvidenceManifestV1Schema, evidence);
  if (evidenceManifest === undefined) throw new Error("eager fragment evidence manifest is malformed");
  if (evidenceManifest.evidence.behaviorManifest.path !== ".tanren/behavior-manifest.json") {
    throw new Error("eager behavior-manifest path does not match the validated evidence contract");
  }
  const manifest = await readMaterializedFile(input, evidenceManifest.evidence.behaviorManifest.path);
  if (manifest === undefined) throw new Error("eager behavior-manifest artifact is unavailable");
  if (parseFragmentBehaviorManifest(manifest) === undefined)
    throw new Error("eager behavior-manifest artifact is malformed");
  const behaviorManifestDigest = contentDigestOf(new TextEncoder().encode(manifest));
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
): Promise<string | undefined> {
  const result = await input.ssh.run(input.target, {
    cwd: input.workspacePath,
    command: `git show ${quoteSshShellArg(`${input.integration.headSha}:${path}`)}`,
    watchdog: outputOnlyWatchdog(),
  });
  if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) return undefined;
  return result.stdout;
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
