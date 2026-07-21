// ds-8 — frozen, intentionally sanitized cross-org design contracts.

import { z } from "zod";

const Id = z.string().trim().min(1).max(256);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Timestamp = z.string().datetime({ offset: true });
const Attribution = z.object({ notice: z.string().trim().min(1).max(4_000) }).strict();
const LossinessReport = z
  .object({ lossless: z.boolean(), warnings: z.array(z.string().trim().min(1).max(500)).max(100) })
  .strict();

/** Public projection only: no org, release/artifact id, object key, bytes, or source metadata. */
export const DesignPublicationV1Schema = z
  .object({
    version: z.literal(1),
    schemaVersion: z.literal("design_publication.v1"),
    publicationId: Id,
    publicSlug: Id,
    releaseDigest: Digest,
    manifestDigest: Digest,
    safePreviewDigest: Digest,
    license: z.string().trim().min(1).max(500),
    attribution: Attribution,
    state: z.enum(["published", "revoked"]),
  })
  .strict();
export type DesignPublicationV1 = z.infer<typeof DesignPublicationV1Schema>;

/** Receipt for an external snapshot; credentials/bearer material cannot fit this shape. */
export const ExternalDesignImportReceiptV1Schema = z
  .object({
    version: z.literal(1),
    schemaVersion: z.literal("design_external_import.v1"),
    source: z.enum(["figma", "registry"]),
    locator: z.string().trim().min(1).max(2_000),
    externalRevision: z.string().trim().min(1).max(500),
    snapshotDigest: Digest,
    licenseVerdict: z.enum(["approved", "unlicensed", "rejected"]),
    lossinessReport: LossinessReport,
    disposition: z.enum(["quarantined", "candidate", "rejected"]),
  })
  .strict();
export type ExternalDesignImportReceiptV1 = z.infer<typeof ExternalDesignImportReceiptV1Schema>;

const PublishCommand = z
  .object({
    type: z.literal("publish"),
    publicationId: Id,
    publicSlug: Id,
    releaseId: Id,
    safePreviewDigest: Digest,
    license: z.string().trim().min(1).max(500),
    attribution: Attribution,
  })
  .strict();
const RevokePublicationCommand = z.object({ type: z.literal("revoke_publication"), publicationId: Id }).strict();
const CreateShareCommand = z
  .object({
    type: z.literal("create_share"),
    shareId: Id,
    publicationId: Id,
    sourceReleaseId: Id,
    releaseDigest: Digest,
    recipientOrgId: Id,
    bearerToken: z.string().trim().min(24).max(4_096),
    permission: z.enum(["import", "fork"]),
    expiresAt: Timestamp,
    redemptionLimit: z.number().int().min(1).max(100_000),
  })
  .strict();
const RedeemShareCommand = z
  .object({
    type: z.literal("redeem_share"),
    grantId: Id,
    publicationId: Id,
    releaseDigest: Digest,
    bearerToken: z.string().trim().min(24).max(4_096),
    grantExpiresAt: Timestamp,
  })
  .strict();
const ForkCommand = z
  .object({
    type: z.literal("fork"),
    importId: Id,
    grantId: Id,
    publicationId: Id,
    releaseDigest: Digest,
    projectId: Id,
    designSystemId: Id,
    releaseId: Id,
    artifactId: Id,
    artifactDigest: Digest,
    validationRunId: Id,
    signature: z.string().trim().min(1).max(512),
    syncPolicy: z.enum(["immutable_fork", "manual_sync"]),
    lastSeenUpstream: z.string().trim().min(1).max(500),
  })
  .strict();
const ExternalSnapshotCommand = z
  .object({
    externalImportId: Id,
    locator: z.string().trim().min(1).max(2_000),
    externalRevision: z.string().trim().min(1).max(500),
    snapshotDigest: Digest,
    licenseVerdict: z.enum(["approved", "unlicensed", "rejected"]),
    lossinessReport: LossinessReport,
  })
  .strict();
const PullFigmaCommand = ExternalSnapshotCommand.extend({ type: z.literal("pull_figma") }).strict();
const ImportRegistryCommand = ExternalSnapshotCommand.extend({ type: z.literal("import_registry") }).strict();
const PushFigmaCommand = z
  .object({
    type: z.literal("push_figma"),
    externalImportId: Id,
    locator: z.string().trim().min(1).max(2_000),
    externalRevision: z.string().trim().min(1).max(500),
    snapshotDigest: Digest,
  })
  .strict();

/** The sole command boundary: strict, closed, and bearer tokens remain input-only. */
export const DesignEcosystemCommandSchema = z.discriminatedUnion("type", [
  PublishCommand,
  RevokePublicationCommand,
  CreateShareCommand,
  RedeemShareCommand,
  ForkCommand,
  PullFigmaCommand,
  ImportRegistryCommand,
  PushFigmaCommand,
]);
export type DesignEcosystemCommand = z.infer<typeof DesignEcosystemCommandSchema>;
