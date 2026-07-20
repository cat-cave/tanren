// F2 FRAGMENT EVIDENCE CONTRACT — frozen, declarative evidence metadata only.
//
// This is intentionally NOT a command surface. A fragment may identify repository
// files that describe its tests and behavior, but it cannot inject a shell command
// into batch evaluation. `.tanren/ci.yml` remains the only executable CI contract.

import { z } from "zod";
import { canonicalJson, contentDigestOf, type Digest } from "../../contracts/cas.js";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_REPOSITORY_PATH = /^[A-Za-z0-9.][A-Za-z0-9._/-]*$/u;

/** A non-blank, repository-relative file path with no shell syntax or traversal. */
export const SafeRepositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      SAFE_REPOSITORY_PATH.test(value) &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === "." || part === ".."),
    "must be a safe repository-relative path without traversal or shell syntax",
  );
const EvidenceManifestReferenceSchema = z
  .object({
    path: SafeRepositoryRelativePathSchema,
    format: z.literal("json"),
  })
  .strict();

/**
 * The persisted F2 evidence declaration. `contentDigest` is a CAS address, never
 * a mutable label: a selector can be considered only when the captured artifact
 * exists at this exact digest under the owning org and project.
 */
const FragmentEvidenceContractV1BaseSchema = z
  .object({
    schemaVersion: z.literal("fragment_evidence.v1"),
    junitReportPath: SafeRepositoryRelativePathSchema,
    testSelector: EvidenceManifestReferenceSchema,
    behaviorManifest: EvidenceManifestReferenceSchema,
    contentDigest: z.string().regex(SHA256_DIGEST),
  })
  .strict();
export type FragmentEvidenceContractV1 = z.infer<typeof FragmentEvidenceContractV1BaseSchema>;

/** Canonical bytes recorded in CAS after the full native gate proves the report exists. */
export function fragmentEvidenceContentBytes(input: FragmentEvidenceContractV1): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({
      schemaVersion: input.schemaVersion,
      junitReportPath: input.junitReportPath,
      testSelector: input.testSelector,
      behaviorManifest: input.behaviorManifest,
    }),
  );
}

export function fragmentEvidenceContentDigest(input: FragmentEvidenceContractV1): Digest {
  return contentDigestOf(fragmentEvidenceContentBytes(input));
}

export const FragmentEvidenceContractV1Schema = FragmentEvidenceContractV1BaseSchema.superRefine((value, context) => {
  if (value.contentDigest !== fragmentEvidenceContentDigest(value)) {
    context.addIssue({ code: "custom", path: ["contentDigest"], message: "must match the immutable evidence content" });
  }
});

/** The one canonical contract schema mirrored in persisted fragment JSONB. */
export const FragmentContractSchema = z
  .object({
    testRunner: z.string().min(1).optional(),
    reportPath: SafeRepositoryRelativePathSchema.optional(),
    dbMigrationsDir: SafeRepositoryRelativePathSchema.optional(),
    ciTier2: z.string().min(1).optional(),
    evidence: FragmentEvidenceContractV1Schema.optional(),
  })
  .strict();
export type FragmentContractShape = z.infer<typeof FragmentContractSchema>;

/** The deterministic repository-local projection emitted by the composer. */
export const FRAGMENT_EVIDENCE_MANIFEST_PATH = ".tanren/evidence-contract.json";

export const FragmentEvidenceManifestV1Schema = z
  .object({
    schemaVersion: z.literal("fragment_evidence_manifest.v1"),
    fragment: z
      .object({
        id: z.string().regex(/^[a-z]+-[a-z0-9._-]+$/u),
        kind: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    evidence: FragmentEvidenceContractV1Schema,
  })
  .strict();
export type FragmentEvidenceManifestV1 = z.infer<typeof FragmentEvidenceManifestV1Schema>;

export function serializeFragmentEvidenceManifest(input: FragmentEvidenceManifestV1): string {
  return `${JSON.stringify(FragmentEvidenceManifestV1Schema.parse(input), null, 2)}\n`;
}
