// F2 EVIDENCE RESOLUTION FOR BATCHES — declarative selection, never command execution.
//
// A resolved selector only binds extra immutable inputs into an existing integration
// proof. It never replaces `runGateForWhen({ when: "pre_merge" })`; every uncertain
// arm returns a typed fallback for that full native gate.

import { contentDigestOf, type Digest } from "../../contracts/cas.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import { quoteSshShellArg } from "../../ssh/command.js";
import { outputOnlyWatchdog } from "../../ssh/activityWatchdog.js";
import { z } from "zod";
import {
  FragmentEvidenceContractV1Schema,
  FragmentEvidenceManifestV1Schema,
  FRAGMENT_EVIDENCE_MANIFEST_PATH,
  SafeRepositoryRelativePathSchema,
  type FragmentEvidenceContractV1,
  type FragmentEvidenceManifestV1,
} from "./fragmentEvidenceContract.js";
import { isCandidateTestPath } from "./functionalTestRecognizer.js";

const TEST_SELECTOR_SCHEMA = z
  .object({
    schemaVersion: z.literal("fragment_test_selector.v1"),
    tests: z.array(SafeRepositoryRelativePathSchema).min(1).max(200),
  })
  .strict();

const BEHAVIOR_MANIFEST_SCHEMA = z
  .object({
    schemaVersion: z.literal("fragment_behavior_manifest.v1"),
    behaviors: z.array(z.string().trim().min(1).max(240)).min(1).max(200),
  })
  .strict();

/**
 * The one strict behavior-manifest decoder.  Consumers outside the batch resolver
 * (including eager proof staging) must use this instead of quietly growing a
 * parallel interpretation of repository-authored behavior data.
 */
export function parseFragmentBehaviorManifest(
  content: string,
): { readonly schemaVersion: "fragment_behavior_manifest.v1"; readonly behaviors: readonly string[] } | undefined {
  const parsed = parseJson(BEHAVIOR_MANIFEST_SCHEMA, content);
  return parsed === undefined || !unique(parsed.behaviors) ? undefined : parsed;
}

const WORKSPACE_IDENTITY_SCHEMA = z
  .object({
    baseSha: z.string().trim().min(1),
    headSha: z.string().trim().min(1),
    treeHash: z.string().trim().min(1),
    memberSetHash: z.string().trim().min(1),
  })
  .strict();

export interface FragmentEvidenceWorkspace {
  readonly ssh: CommandSubstrate;
  readonly target: RunnerHandle;
  readonly workspacePath: string;
}

/** The selected persisted F2 row, parsed before this resolver trusts it. */
export interface SelectedF2FragmentEvidence {
  readonly id: string;
  readonly kind: string;
  readonly version: string;
  readonly evidence: FragmentEvidenceContractV1;
}

/** Existing verification-artifact evidence, scoped by the production loader. */
export interface CapturedFragmentEvidenceArtifact {
  readonly casDigest: Digest;
  /** Integration proof units intentionally have no FK into verification artifacts. */
  readonly proofUnitDigest: null;
}

export interface FragmentEvidenceProofRequest {
  readonly workspaceIdentity: {
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
    readonly memberSetHash: string;
  };
  /** Every changed candidate test path, derived from the exact local integration. */
  readonly changedTestPaths: readonly string[];
  /** A captured artifact read under the owning org/project scope, if one exists. */
  readonly capturedArtifact: CapturedFragmentEvidenceArtifact | undefined;
  /** Internal production hand-off avoids a second remote read after DB lookup. */
  readonly composedManifest?: FragmentEvidenceManifestV1;
}

export type FragmentEvidenceFallbackReason =
  | "manifest_absent"
  | "manifest_unreadable"
  | "manifest_malformed"
  | "fragment_absent"
  | "fragment_mismatch"
  | "selector_unreadable"
  | "selector_malformed"
  | "behavior_manifest_unreadable"
  | "behavior_manifest_malformed"
  | "changed_tests_empty"
  | "changed_tests_invalid"
  | "selector_set_mismatch"
  | "artifact_absent"
  | "artifact_digest_mismatch"
  | "workspace_identity_invalid";

export type FragmentEvidenceResolution =
  | {
      readonly kind: "selected";
      readonly selector: { readonly path: string; readonly format: "json"; readonly tests: readonly string[] };
      readonly behaviorManifest: {
        readonly path: string;
        readonly format: "json";
        readonly behaviors: readonly string[];
      };
      readonly artifactDigest: Digest;
      /** Hash of exactly the selector, behaviour, artifact, and integrated content bound to this proof. */
      readonly inputHash: string;
      readonly manifest: FragmentEvidenceManifestV1;
    }
  | { readonly kind: "fallback"; readonly reason: FragmentEvidenceFallbackReason };

type ReadResult = { readonly kind: "ok"; readonly content: string } | { readonly kind: "absent" | "unreadable" };

/** Read and strictly parse the composed evidence artifact without executing its content. */
export async function readComposedFragmentEvidenceManifest(
  workspace: FragmentEvidenceWorkspace,
): Promise<FragmentEvidenceManifestV1 | FragmentEvidenceFallbackReason> {
  const file = await readRepositoryFile(workspace, FRAGMENT_EVIDENCE_MANIFEST_PATH);
  if (file.kind !== "ok") return file.kind === "absent" ? "manifest_absent" : "manifest_unreadable";
  return parseJson(FragmentEvidenceManifestV1Schema, file.content) ?? "manifest_malformed";
}

/** Read the declared JUnit bytes only after the native full gate produced them. */
export async function readDeclaredFragmentEvidenceReport(
  workspace: FragmentEvidenceWorkspace,
  evidence: FragmentEvidenceContractV1,
): Promise<Uint8Array | undefined> {
  const report = await readRepositoryFile(workspace, evidence.junitReportPath);
  return report.kind === "ok" ? new TextEncoder().encode(report.content) : undefined;
}

/**
 * Resolve only fully matching frozen evidence. Failure is deliberately data, not
 * an exception: callers route every fallback through the ordinary full gate.
 */
export async function resolveFragmentEvidenceForBatch(
  workspace: FragmentEvidenceWorkspace,
  fragment: SelectedF2FragmentEvidence | undefined,
  proofRequest: FragmentEvidenceProofRequest,
): Promise<FragmentEvidenceResolution> {
  const manifest = proofRequest.composedManifest ?? (await readComposedFragmentEvidenceManifest(workspace));
  if (typeof manifest === "string") return { kind: "fallback", reason: manifest };
  const identity = WORKSPACE_IDENTITY_SCHEMA.safeParse(proofRequest.workspaceIdentity);
  if (!identity.success) return { kind: "fallback", reason: "workspace_identity_invalid" };
  if (fragment === undefined) return { kind: "fallback", reason: "fragment_absent" };
  if (!matchesFragmentEvidenceManifest(manifest, fragment)) return { kind: "fallback", reason: "fragment_mismatch" };

  const selectorFile = await readRepositoryFile(workspace, manifest.evidence.testSelector.path);
  if (selectorFile.kind !== "ok") return { kind: "fallback", reason: "selector_unreadable" };
  const selector = parseJson(TEST_SELECTOR_SCHEMA, selectorFile.content);
  if (selector === undefined || !unique(selector.tests) || !selector.tests.every(isCandidateTestPath)) {
    return { kind: "fallback", reason: "selector_malformed" };
  }

  const behaviorsFile = await readRepositoryFile(workspace, manifest.evidence.behaviorManifest.path);
  if (behaviorsFile.kind !== "ok") return { kind: "fallback", reason: "behavior_manifest_unreadable" };
  const behaviors = parseFragmentBehaviorManifest(behaviorsFile.content);
  if (behaviors === undefined) {
    return { kind: "fallback", reason: "behavior_manifest_malformed" };
  }

  const changed = proofRequest.changedTestPaths;
  if (changed.length === 0) return { kind: "fallback", reason: "changed_tests_empty" };
  if (!changed.every((path) => SafeRepositoryRelativePathSchema.safeParse(path).success && isCandidateTestPath(path))) {
    return { kind: "fallback", reason: "changed_tests_invalid" };
  }
  if (!unique(changed) || !sameSet(changed, selector.tests))
    return { kind: "fallback", reason: "selector_set_mismatch" };

  const artifact = proofRequest.capturedArtifact;
  if (artifact === undefined) return { kind: "fallback", reason: "artifact_absent" };
  if (artifact.proofUnitDigest !== null || artifact.casDigest !== manifest.evidence.contentDigest) {
    return { kind: "fallback", reason: "artifact_digest_mismatch" };
  }

  const inputHash = contentDigestOf(
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: "fragment_batch_evidence_input.v1",
        artifactDigest: artifact.casDigest,
        behaviorManifest: { path: manifest.evidence.behaviorManifest.path, behaviors: sorted(behaviors.behaviors) },
        fragment: manifest.fragment,
        selector: { path: manifest.evidence.testSelector.path, tests: sorted(selector.tests) },
        workspaceIdentity: identity.data,
      }),
    ),
  );
  return {
    kind: "selected",
    selector: { path: manifest.evidence.testSelector.path, format: "json", tests: sorted(selector.tests) },
    behaviorManifest: {
      path: manifest.evidence.behaviorManifest.path,
      format: "json",
      behaviors: sorted(behaviors.behaviors),
    },
    artifactDigest: artifact.casDigest,
    inputHash,
    manifest,
  };
}

export function matchesFragmentEvidenceManifest(
  manifest: FragmentEvidenceManifestV1,
  fragment: SelectedF2FragmentEvidence,
): boolean {
  const evidence = FragmentEvidenceContractV1Schema.safeParse(fragment.evidence);
  return (
    evidence.success &&
    manifest.fragment.id === fragment.id &&
    manifest.fragment.kind === fragment.kind &&
    manifest.fragment.version === fragment.version &&
    JSON.stringify(manifest.evidence) === JSON.stringify(evidence.data)
  );
}

function parseJson<T>(schema: z.ZodType<T>, content: string): T | undefined {
  try {
    return schema.parse(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

/** Exact multiset equality, not subset matching: no stale missing/excess selector may pass. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = sorted(left);
  const b = sorted(right);
  return a.every((value, index) => value === b[index]);
}

/**
 * Static file read only. The user-authored paths were parsed as safe repository
 * paths before this point, and their content is parsed as data; no manifest field
 * is ever interpolated into an executable CI command.
 */
async function readRepositoryFile(workspace: FragmentEvidenceWorkspace, relativePath: string): Promise<ReadResult> {
  const path = `${workspace.workspacePath.replace(/\/+$/u, "")}/${relativePath}`;
  const result = await workspace.ssh.run(workspace.target, {
    command: `if [ -f ${quoteSshShellArg(path)} ]; then cat -- ${quoteSshShellArg(path)}; else exit 3; fi`,
    watchdog: outputOnlyWatchdog(),
  });
  if (result.failure !== undefined || result.stalled === true) return { kind: "unreadable" };
  if (result.exitCode === 3) return { kind: "absent" };
  if (result.exitCode !== 0) return { kind: "unreadable" };
  return { kind: "ok", content: result.stdout };
}
