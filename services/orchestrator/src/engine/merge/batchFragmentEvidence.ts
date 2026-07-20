// BATCH → F2 EVIDENCE WIRING. This is the production adapter between the open
// jj-local workspace and the declarative fragment resolver. It reads files and
// scoped rows only; it never derives or runs a shell command from fragment data.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import { parseDigest } from "../contracts/cas.js";
import { PgCasByteStore } from "../cas/pgCasByteStore.js";
import type { LiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import { FragmentContractSchema } from "../templates/fragments/fragmentEvidenceContract.js";
import { fragmentEvidenceContentBytes } from "../templates/fragments/fragmentEvidenceContract.js";
import { isCandidateTestPath } from "../templates/fragments/functionalTestRecognizer.js";
import {
  readComposedFragmentEvidenceManifest,
  readDeclaredFragmentEvidenceReport,
  resolveFragmentEvidenceForBatch,
  type CapturedFragmentEvidenceArtifact,
  type FragmentEvidenceResolution,
  type SelectedF2FragmentEvidence,
} from "../templates/fragments/resolveFragmentEvidenceForBatch.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { outputOnlyWatchdog } from "../ssh/activityWatchdog.js";
import { PgVerificationCaptureStore } from "../verification/acceptance/renderCaptureStore.js";
import type {
  BatchFragmentEvidenceRequest,
  CaptureBatchFragmentEvidence,
  ResolveBatchFragmentEvidence,
} from "./batchIntegrationNodeDrive.js";

const FRAGMENT_ROW_SCHEMA = z
  .object({
    kind: z.string().min(1),
    label: z.string().min(1),
    version: z.string().min(1),
    contract: z.unknown(),
  })
  .strict();

const ARTIFACT_ROW_SCHEMA = z
  .object({
    cas_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    proof_unit_digest: z.null(),
  })
  .strict();

/** Construct the real resolver called by every production batch immediately before graph evaluation. */
export function buildBatchFragmentEvidenceResolver(pool: pg.Pool): ResolveBatchFragmentEvidence {
  return async (live: LiveJjWorkspace, request: BatchFragmentEvidenceRequest): Promise<FragmentEvidenceResolution> => {
    const workspace = { ssh: request.ssh, target: live.target, workspacePath: live.workspacePath };
    const changedTestPaths = await changedTests(workspace, request.baseSha, request.localRef);
    const baseRequest = {
      workspaceIdentity: {
        baseSha: request.baseSha,
        headSha: request.headSha,
        treeHash: request.treeHash,
        memberSetHash: request.memberSetHash,
      },
      changedTestPaths,
      capturedArtifact: undefined,
    } as const;
    const manifest = await readComposedFragmentEvidenceManifest(workspace);
    if (typeof manifest === "string") {
      // Deliberately call the named resolver even when the manifest is absent or
      // unreadable: this is the live fail-closed production trigger, not a fake seam.
      return resolveFragmentEvidenceForBatch(workspace, undefined, baseRequest);
    }
    const fragment = await loadSelectedFragment(pool, request.orgId, manifest.fragment);
    const artifact = await loadCapturedArtifact(
      pool,
      request.orgId,
      request.projectId,
      manifest.evidence.contentDigest,
    );
    return resolveFragmentEvidenceForBatch(workspace, fragment, {
      ...baseRequest,
      capturedArtifact: artifact,
      composedManifest: manifest,
    });
  };
}

/**
 * Capture a report only after the real native pre-merge gate passed. The expected
 * digest is verified against the report bytes by the sole CAS capture store; a
 * mismatch leaves no artifact, so the next batch remains on the full-gate path.
 */
export function buildBatchFragmentEvidenceCapture(pool: pg.Pool): CaptureBatchFragmentEvidence {
  const resolve = buildBatchFragmentEvidenceResolver(pool);
  return async (live, request) => {
    const resolution = await resolve(live, request);
    if (resolution.kind !== "fallback" || resolution.reason !== "artifact_absent") return;
    const workspace = { ssh: request.ssh, target: live.target, workspacePath: live.workspacePath };
    const manifest = await readComposedFragmentEvidenceManifest(workspace);
    if (typeof manifest === "string") return;
    const report = await readDeclaredFragmentEvidenceReport(workspace, manifest.evidence);
    if (report === undefined || report.byteLength === 0) return;
    const bytes = fragmentEvidenceContentBytes(manifest.evidence);
    await new PgVerificationCaptureStore(pool, new PgCasByteStore(pool)).capture({
      orgId: request.orgId,
      projectId: request.projectId,
      kind: "fragment_evidence_contract",
      mediaType: "application/vnd.tanren.fragment-evidence-contract+json",
      bytes,
      expectedDigest: parseDigest(manifest.evidence.contentDigest),
      redactionClass: "sensitive",
    });
  };
}

async function loadSelectedFragment(
  pool: pg.Pool,
  orgId: string,
  manifestFragment: { readonly id: string; readonly kind: string; readonly version: string },
): Promise<SelectedF2FragmentEvidence | undefined> {
  const prefix = `${manifestFragment.kind}-`;
  if (!manifestFragment.id.startsWith(prefix)) return undefined;
  const label = manifestFragment.id.slice(prefix.length);
  if (label.trim() === "") return undefined;
  const selected = await runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT kind, label, version, contract
         FROM fragments
        WHERE org_id = $1 AND kind = $2 AND label = $3 AND version = $4 AND status = 'validated'`,
      [orgId, manifestFragment.kind, label, manifestFragment.version],
    );
    if (result.rowCount !== 1) return null;
    const parsed = FRAGMENT_ROW_SCHEMA.safeParse(result.rows[0]);
    if (!parsed.success) return null;
    const contract = FragmentContractSchema.safeParse(parsed.data.contract);
    if (!contract.success || contract.data.evidence === undefined) return null;
    return {
      id: `${parsed.data.kind}-${parsed.data.label}`,
      kind: parsed.data.kind,
      version: parsed.data.version,
      evidence: contract.data.evidence,
    };
  });
  return selected === null ? undefined : selected;
}

async function loadCapturedArtifact(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  digest: string,
): Promise<CapturedFragmentEvidenceArtifact | undefined> {
  const artifact = await runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT cas_digest, proof_unit_digest
         FROM verification_artifacts
        WHERE org_id = $1 AND project_id = $2 AND cas_digest = $3 AND proof_unit_digest IS NULL`,
      [orgId, projectId, digest],
    );
    if (result.rowCount !== 1) return null;
    const parsed = ARTIFACT_ROW_SCHEMA.safeParse(result.rows[0]);
    if (!parsed.success) return null;
    return { casDigest: parseDigest(parsed.data.cas_digest), proofUnitDigest: null };
  });
  return artifact === null ? undefined : artifact;
}

async function changedTests(
  workspace: { ssh: BatchFragmentEvidenceRequest["ssh"]; target: LiveJjWorkspace["target"]; workspacePath: string },
  baseSha: string,
  localRef: string,
): Promise<string[]> {
  const result = await workspace.ssh.run(workspace.target, {
    command: `jj diff --name-only --from ${quoteSshShellArg(baseSha)} --to ${quoteSshShellArg(localRef)}`,
    cwd: workspace.workspacePath,
    watchdog: outputOnlyWatchdog(),
  });
  if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => isCandidateTestPath(path));
}
