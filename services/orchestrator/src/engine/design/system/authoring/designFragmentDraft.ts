// ds-3 (F2D) — the DESIGN-fragment DRAFT the writer produces + its VALIDATED form.
//
// A design fragment is a declarative apply plan: a set of source FILES the fragment
// contributes to the design VFS, each added through one typed `DesignVfsOperation`
// (the same constrained op set ds-1's `DesignVfs` exposes). This is the design
// analog of the code-fragment `{ bodyTs }` writer output — but structured, because
// the design substrate composes typed operations, not raw TS.
//
// NO SILENT DEFAULTS: a malformed draft throws `DesignFragmentDraftCorruptError`
// (fail-closed), exactly like the ds-0 contract/artifact parsers.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DesignArtifactFileKind,
  DesignFragmentPhase,
  type DesignArtifactFileV1,
  type DesignFragmentSpecV1,
} from "../designArtifactSchemas.js";

/** The typed VFS operations a fragment's apply plan may perform (mirrors the
 * `DesignVfsOperation` union in `designTargetAdapter.ts`, as a runtime enum). */
export const DesignVfsOperationSchema = z.enum([
  "addTokenSet",
  "addMode",
  "addAlias",
  "addComponent",
  "addScenario",
  "addAsset",
  "addExporter",
  "addCatalogRoute",
]);

/** One apply-plan step: a file added to the design VFS via one typed operation. */
export const DesignFragmentDraftOperation = z
  .object({
    operation: DesignVfsOperationSchema,
    path: z.string().min(1).max(1024),
    fileKind: DesignArtifactFileKind,
    mediaType: z.string().min(1).max(256),
    // The ACTUAL source text of the file. The validator content-addresses this into
    // a `DesignArtifactFileV1` descriptor (digest + byteSize) before it enters a VFS.
    content: z.string().max(1_000_000),
    executable: z.boolean().default(false),
  })
  .strict();
export type DesignFragmentDraftOperation = z.infer<typeof DesignFragmentDraftOperation>;

/** The writer's structured output — a complete, self-describing design fragment. */
export const DesignFragmentDraftV1 = z
  .object({
    kind: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    phase: DesignFragmentPhase,
    version: z.string().min(1).max(128),
    targetCapabilities: z.array(z.string().min(1).max(120)).max(256).default([]),
    requires: z.array(z.string().min(1).max(200)).max(256).default([]),
    provides: z.array(z.string().min(1).max(200)).max(256).default([]),
    dependsOn: z.array(z.string().min(1).max(200)).max(256).default([]),
    conflicts: z.array(z.string().min(1).max(200)).max(256).default([]),
    replaces: z.array(z.string().min(1).max(200)).max(256).default([]),
    personaRefs: z.array(z.string().min(1).max(256)).max(1024).default([]),
    behaviorRefs: z.array(z.string().min(1).max(256)).max(1024).default([]),
    conformanceSuiteId: z.string().min(1).max(200),
    operations: z.array(DesignFragmentDraftOperation).min(1).max(4096),
  })
  .strict();
export type DesignFragmentDraftV1 = z.infer<typeof DesignFragmentDraftV1>;

/** Thrown when a writer body does not parse as a valid `DesignFragmentDraftV1`. */
export class DesignFragmentDraftCorruptError extends Error {
  constructor(readonly issues: string) {
    super(`design fragment draft is corrupt: ${issues}`);
    this.name = "DesignFragmentDraftCorruptError";
  }
}

/** Parse an unknown writer body into a typed draft (fail-closed). */
export function parseDesignFragmentDraft(value: unknown): DesignFragmentDraftV1 {
  const result = DesignFragmentDraftV1.safeParse(value);
  if (!result.success) {
    throw new DesignFragmentDraftCorruptError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "),
    );
  }
  return result.data;
}

/** The result of validating a draft against the ds-0/1/2 design substrate. This is
 * the artifact the kernel persists; the retracted-on-batch-reject unit is absent. */
export interface ValidatedDesignFragment {
  /** Deterministic release id: `${orgId}:${kind}-${label}:${version}` (the reuse key). */
  readonly fragmentReleaseId: string;
  /** Content address of the canonical draft body (`sha256:<hex>`). */
  readonly fragmentDigest: string;
  readonly fragmentVersion: string;
  /** The resolved fragment spec (cross-checked against the requested spec). */
  readonly spec: DesignFragmentSpecV1;
  /** The resolved artifact file descriptors (path/kind/mediaType/digest/byteSize). */
  readonly files: readonly DesignArtifactFileV1[];
  /** The canonical draft JSON persisted as the fragment body. */
  readonly canonicalBody: string;
  /** The parsed draft (retained for the batch compose). */
  readonly draft: DesignFragmentDraftV1;
}

/** Canonical, schema-normalized JSON for a draft — the digest + persistence body.
 * Round-trips to identity by construction (parse then re-serialize field order). */
export function canonicalDesignFragmentDraftJson(draft: DesignFragmentDraftV1): string {
  return JSON.stringify(parseDesignFragmentDraft(draft));
}

/** Content-address a canonical draft body. */
export function designFragmentDraftDigest(draft: DesignFragmentDraftV1): string {
  const body = canonicalDesignFragmentDraftJson(draft);
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

/** Deterministic release id for a fragment — the same formula persistence inserts
 * as the row id, so the `succeeded` event's `fragmentReleaseId` is derivable from
 * the validated artifact ALONE (the kernel's succeeded lifecycle carries no id). */
export function designFragmentReleaseId(orgId: string, kind: string, label: string, version: string): string {
  return `${orgId}:${kind}-${label}:${version}`;
}
