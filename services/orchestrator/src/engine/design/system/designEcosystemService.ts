import { createHash } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../../eventStore.js";
import {
  DesignEcosystemCommandSchema,
  DesignPublicationV1Schema,
  type DesignEcosystemCommand,
  type DesignPublicationV1,
  type ExternalDesignImportReceiptV1,
} from "./designEcosystemContracts.js";
import { recordExternalDesignImport } from "./designEcosystemExternalBridge.js";

export class DesignEcosystemError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "blocked",
    detail: string,
  ) {
    super(detail);
    this.name = "DesignEcosystemError";
  }
}

export interface DesignEcosystemExecution {
  readonly orgId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly command: unknown;
}

export type DesignEcosystemResult =
  | { readonly kind: "publication"; readonly publication: DesignPublicationV1 }
  | { readonly kind: "share_created"; readonly shareId: string; readonly publicationId: string }
  | { readonly kind: "grant_redeemed"; readonly grantId: string; readonly publication: DesignPublicationV1 }
  | {
      readonly kind: "fork_published";
      readonly importId: string;
      readonly releaseId: string;
      readonly artifactId: string;
    }
  | {
      readonly kind: "external_import_recorded";
      readonly externalImportId: string;
      readonly receipt: ExternalDesignImportReceiptV1;
    };

interface PublicRow {
  publication_id: string;
  public_slug: string;
  source_release_digest: string;
  manifest_digest: string;
  safe_preview_digest: string;
  license: string;
  attribution: unknown;
  state: string;
}

interface GrantRow {
  id: string;
  publication_id: string;
  allowed_release_digest: string;
  capability: string;
}

interface ExpectedGrantCoordinate {
  readonly grantId: string;
  readonly publicationId: string;
  readonly releaseDigest: string;
}

export class DesignEcosystemService {
  constructor(private readonly pool: pg.Pool) {}

  async execute(input: DesignEcosystemExecution): Promise<DesignEcosystemResult> {
    const command = DesignEcosystemCommandSchema.parse(input.command);
    requireNonblank(input.orgId, "org id");
    requireNonblank(input.actorId, "actor id");
    requireNonblank(input.idempotencyKey, "idempotency key");
    switch (command.type) {
      case "publish":
        return { kind: "publication", publication: await this.publish(input.orgId, command) };
      case "revoke_publication":
        return { kind: "publication", publication: await this.revoke(command.publicationId) };
      case "create_share":
        await this.createShare(input.orgId, command);
        return { kind: "share_created", shareId: command.shareId, publicationId: command.publicationId };
      case "redeem_share":
        return this.redeemShare(input.orgId, input.idempotencyKey, command);
      case "fork":
        return this.publishFork(input.orgId, input.actorId, command);
      case "pull_figma":
        return recordExternalDesignImport(this.pool, input.orgId, command, "figma", ecosystemError);
      case "import_registry":
        return recordExternalDesignImport(this.pool, input.orgId, command, "registry", ecosystemError);
      case "push_figma":
        throw new DesignEcosystemError("blocked", "figma push has no configured production transport");
      default:
        throw new DesignEcosystemError("blocked", "unsupported design ecosystem command");
    }
  }

  async readPublic(publicationId: string): Promise<DesignPublicationV1> {
    requireNonblank(publicationId, "publication id");
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<PublicRow>(
        `SELECT publication_id, public_slug, source_release_digest, manifest_digest,
                safe_preview_digest, license, attribution, state
           FROM published_design_system_releases
          WHERE publication_id = $1 AND state = 'published' AND revoked_at IS NULL`,
        [publicationId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new DesignEcosystemError("not_found", "public publication unavailable");
      return publicRow(row);
    });
  }

  private async publish(
    orgId: string,
    command: Extract<DesignEcosystemCommand, { type: "publish" }>,
  ): Promise<DesignPublicationV1> {
    const source = await runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ contract_digest: string; manifest_digest: string }>(
        `SELECT release.contract_digest, artifact.digest AS manifest_digest
           FROM design_system_releases release
           JOIN design_artifacts artifact
             ON artifact.org_id = release.org_id AND artifact.id = release.canonical_artifact_id
          WHERE release.org_id = $1 AND release.id = $2 AND release.state = 'published'`,
        [orgId, command.releaseId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new DesignEcosystemError("not_found", "published source release unavailable");
      return row;
    });
    return runWithSystemScope(this.pool, async (client) => {
      await client.query(
        `INSERT INTO published_design_system_releases
           (publication_id, public_slug, source_release_digest, manifest_digest,
            safe_preview_digest, license, attribution, state, revoked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'published', NULL, now())
         ON CONFLICT (publication_id) DO NOTHING`,
        [
          command.publicationId,
          command.publicSlug,
          source.contract_digest,
          source.manifest_digest,
          command.safePreviewDigest,
          command.license,
          JSON.stringify(command.attribution),
        ],
      );
      const result = await client.query<PublicRow>(
        `SELECT publication_id, public_slug, source_release_digest, manifest_digest,
                safe_preview_digest, license, attribution, state
           FROM published_design_system_releases WHERE publication_id = $1`,
        [command.publicationId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new DesignEcosystemError("blocked", "publication was not readable after write");
      const publication = publicRow(row);
      const requested = DesignPublicationV1Schema.parse({
        version: 1,
        schemaVersion: "design_publication.v1",
        publicationId: command.publicationId,
        publicSlug: command.publicSlug,
        releaseDigest: source.contract_digest,
        manifestDigest: source.manifest_digest,
        safePreviewDigest: command.safePreviewDigest,
        license: command.license,
        attribution: command.attribution,
        state: "published",
      });
      if (JSON.stringify(publication) !== JSON.stringify(requested)) {
        throw new DesignEcosystemError("conflict", "publication id is already bound to a different projection");
      }
      return publication;
    });
  }

  private async revoke(publicationId: string): Promise<DesignPublicationV1> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<PublicRow>(
        `UPDATE published_design_system_releases
            SET state = 'revoked', revoked_at = now(), updated_at = now()
          WHERE publication_id = $1 AND state = 'published' AND revoked_at IS NULL
        RETURNING publication_id, public_slug, source_release_digest, manifest_digest,
                  safe_preview_digest, license, attribution, state`,
        [publicationId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new DesignEcosystemError("not_found", "published publication unavailable");
      return publicRow(row);
    });
  }

  private async createShare(
    orgId: string,
    command: Extract<DesignEcosystemCommand, { type: "create_share" }>,
  ): Promise<void> {
    const publication = await this.readPublic(command.publicationId);
    if (publication.releaseDigest !== command.releaseDigest) {
      throw new DesignEcosystemError("not_found", "publication digest unavailable");
    }
    await runWithOrgScope(this.pool, orgId, async (client) => {
      const source = await client.query<{ id: string }>(
        `SELECT id FROM design_system_releases
          WHERE org_id = $1 AND id = $2 AND contract_digest = $3 AND state = 'published'`,
        [orgId, command.sourceReleaseId, command.releaseDigest],
      );
      if (source.rowCount !== 1) {
        throw new DesignEcosystemError("not_found", "source release is not owned by the sharing organization");
      }
      await client.query(
        `INSERT INTO design_share_links
           (org_id, id, publication_id, source_release_id, source_release_digest, recipient_org_id,
            token_hash, permission, expires_at, redemption_count, redemption_limit, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, 0, $10, NULL)
         ON CONFLICT (org_id, id) DO NOTHING`,
        [
          orgId,
          command.shareId,
          command.publicationId,
          command.sourceReleaseId,
          command.releaseDigest,
          command.recipientOrgId,
          tokenHash(command.bearerToken),
          command.permission,
          command.expiresAt,
          command.redemptionLimit,
        ],
      );
      const result = await client.query<{
        publication_id: string;
        source_release_id: string;
        source_release_digest: string;
        token_hash: string;
      }>(
        `SELECT publication_id, source_release_id, source_release_digest, token_hash
           FROM design_share_links WHERE org_id = $1 AND id = $2`,
        [orgId, command.shareId],
      );
      const row = result.rows[0];
      if (
        row === undefined ||
        row.publication_id !== command.publicationId ||
        row.source_release_id !== command.sourceReleaseId ||
        row.source_release_digest !== command.releaseDigest ||
        row.token_hash !== tokenHash(command.bearerToken)
      ) {
        throw new DesignEcosystemError("conflict", "share id is already bound to different authorization");
      }
    });
  }

  private async redeemShare(
    orgId: string,
    idempotencyKey: string,
    command: Extract<DesignEcosystemCommand, { type: "redeem_share" }>,
  ): Promise<DesignEcosystemResult> {
    const expected = {
      grantId: command.grantId,
      publicationId: command.publicationId,
      releaseDigest: command.releaseDigest,
    };
    const existing = await this.readGrant(orgId, idempotencyKey, expected);
    if (existing !== null) return existing;
    const grant = await runWithSystemScope(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [idempotencyKey]);
      const prior = await client.query<GrantRow>(
        `SELECT id, publication_id, allowed_release_digest, capability
           FROM design_system_grants WHERE org_id = $1 AND idempotency_key = $2`,
        [orgId, idempotencyKey],
      );
      const priorRow = prior.rows[0];
      if (priorRow !== undefined) return priorRow;
      const redeemed = await client.query<{
        permission: string;
        publication_id: string;
        source_release_digest: string;
      }>(
        `UPDATE design_share_links share
            SET redemption_count = share.redemption_count + 1
           FROM published_design_system_releases publication, design_system_releases source_release
          WHERE share.token_hash = $1
            AND share.recipient_org_id = $2
            AND share.publication_id = $3
            AND share.source_release_digest = $4
            AND share.revoked_at IS NULL
            AND share.expires_at > now()
            AND share.redemption_count < share.redemption_limit
            AND publication.publication_id = share.publication_id
            AND publication.source_release_digest = share.source_release_digest
            AND publication.state = 'published'
            AND publication.revoked_at IS NULL
            AND source_release.org_id = share.org_id
            AND source_release.id = share.source_release_id
            AND source_release.contract_digest = share.source_release_digest
            AND source_release.state = 'published'
            AND $5::timestamptz > now()
            AND $5::timestamptz <= share.expires_at
         RETURNING share.permission, share.publication_id, share.source_release_digest`,
        [tokenHash(command.bearerToken), orgId, command.publicationId, command.releaseDigest, command.grantExpiresAt],
      );
      const redemption = redeemed.rows[0];
      if (redemption === undefined) throw new DesignEcosystemError("not_found", "share token unavailable");
      const inserted = await client.query<GrantRow>(
        `INSERT INTO design_system_grants
           (org_id, id, idempotency_key, publication_id, allowed_release_digest,
            capability, expires_at, revoked_at, import_policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, NULL, '{}'::jsonb)
         RETURNING id, publication_id, allowed_release_digest, capability`,
        [
          orgId,
          command.grantId,
          idempotencyKey,
          redemption.publication_id,
          redemption.source_release_digest,
          redemption.permission,
          command.grantExpiresAt,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new DesignEcosystemError("blocked", "grant was not created after redemption");
      return row;
    });
    const publicGrant = await this.readGrant(orgId, idempotencyKey, expected);
    if (publicGrant === null || publicGrant.grantId !== grant.id) {
      throw new DesignEcosystemError("blocked", "redeemed grant was not readable in destination scope");
    }
    return publicGrant;
  }

  private async readGrant(
    orgId: string,
    idempotencyKey: string,
    expected?: ExpectedGrantCoordinate,
  ): Promise<Extract<DesignEcosystemResult, { kind: "grant_redeemed" }> | null> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<GrantRow>(
        `SELECT id, publication_id, allowed_release_digest, capability
           FROM design_system_grants WHERE org_id = $1 AND idempotency_key = $2`,
        [orgId, idempotencyKey],
      );
      const grant = result.rows[0];
      if (grant === undefined) return null;
      if (
        expected !== undefined &&
        (grant.id !== expected.grantId ||
          grant.publication_id !== expected.publicationId ||
          grant.allowed_release_digest !== expected.releaseDigest)
      ) {
        throw new DesignEcosystemError("conflict", "idempotency key is already bound to a different grant");
      }
      const publication = await this.readPublic(grant.publication_id);
      if (
        publication.releaseDigest !== grant.allowed_release_digest ||
        !["import", "fork"].includes(grant.capability)
      ) {
        throw new DesignEcosystemError("blocked", "grant coordinate is corrupt");
      }
      return { kind: "grant_redeemed", grantId: grant.id, publication };
    });
  }

  private async publishFork(
    orgId: string,
    actorId: string,
    command: Extract<DesignEcosystemCommand, { type: "fork" }>,
  ): Promise<DesignEcosystemResult> {
    await runWithOrgScope(this.pool, orgId, async (client) => {
      const grant = await client.query<{ id: string }>(
        `SELECT grant.id FROM design_system_grants grant
           JOIN published_design_system_releases publication ON publication.publication_id = grant.publication_id
          WHERE grant.org_id = $1 AND grant.id = $2 AND grant.publication_id = $3
            AND grant.allowed_release_digest = $4 AND grant.capability = 'fork'
            AND grant.revoked_at IS NULL AND grant.expires_at > now()
            AND publication.state = 'published' AND publication.revoked_at IS NULL
            AND publication.source_release_digest = $4`,
        [orgId, command.grantId, command.publicationId, command.releaseDigest],
      );
      if (grant.rowCount !== 1) throw new DesignEcosystemError("not_found", "active fork grant unavailable");
      const artifact = await client.query<{ digest: string }>(
        `SELECT digest FROM design_artifacts
          WHERE org_id = $1 AND id = $2 AND design_system_id = $3 AND digest = $4`,
        [orgId, command.artifactId, command.designSystemId, command.artifactDigest],
      );
      if (artifact.rowCount !== 1) throw new DesignEcosystemError("not_found", "destination artifact unavailable");
      const proof = await client.query<{ id: string }>(
        `SELECT id FROM design_adapter_conformance_runs
          WHERE org_id = $1 AND project_id = $2 AND id = $3 AND release_id = $4
            AND artifact_id = $5 AND artifact_digest = $6 AND outcome = 'passed' AND receipt IS NOT NULL`,
        [
          orgId,
          command.projectId,
          command.validationRunId,
          command.releaseId,
          command.artifactId,
          command.artifactDigest,
        ],
      );
      if (proof.rowCount !== 1)
        throw new DesignEcosystemError("blocked", "exact destination conformance proof unavailable");
      const render = await client.query<{ id: string }>(
        `SELECT id FROM design_render_land_verdicts
          WHERE org_id = $1 AND project_id = $2 AND release_id = $3 AND outcome = 'passed'`,
        [orgId, command.projectId, command.releaseId],
      );
      if (render.rowCount !== 1) throw new DesignEcosystemError("blocked", "destination render proof unavailable");
      const released = await client.query<{ id: string; version: number; contract_digest: string }>(
        `UPDATE design_system_releases
            SET state = 'published', canonical_artifact_id = $1, published_by = $2, published_at = now()
          WHERE org_id = $3 AND id = $4 AND design_system_id = $5
            AND state = 'validated' AND canonical_artifact_id IS NULL
        RETURNING id, version, contract_digest`,
        [command.artifactId, actorId, orgId, command.releaseId, command.designSystemId],
      );
      const release = released.rows[0];
      if (release === undefined) throw new DesignEcosystemError("blocked", "destination release is not publishable");
      const imported = await client.query<{ id: string }>(
        `INSERT INTO design_imports
           (org_id, id, publication_id, source_release_digest, design_system_id,
            release_id, attribution, sync_policy, last_seen_upstream)
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8)
         ON CONFLICT (org_id, publication_id) DO NOTHING RETURNING id`,
        [
          orgId,
          command.importId,
          command.publicationId,
          command.releaseDigest,
          command.designSystemId,
          command.releaseId,
          command.syncPolicy,
          command.lastSeenUpstream,
        ],
      );
      if (imported.rowCount !== 1)
        throw new DesignEcosystemError("conflict", "publication already has a destination fork");
      const events = new PgEventStore(client);
      await events.append({
        orgId,
        projectId: command.projectId,
        eventType: "designSystem.release.published",
        payload: {
          releaseId: command.releaseId,
          designSystemId: command.designSystemId,
          version: release.version,
          manifestDigest: command.artifactDigest,
          signature: command.signature,
          validationRunId: command.validationRunId,
          publishedBy: actorId,
        },
      });
      await events.append({
        orgId,
        projectId: command.projectId,
        eventType: "design.artifact.published",
        payload: {
          projectId: command.projectId,
          artifactId: command.artifactId,
          releaseId: command.releaseId,
          artifactDigest: command.artifactDigest,
        },
      });
    });
    return {
      kind: "fork_published",
      importId: command.importId,
      releaseId: command.releaseId,
      artifactId: command.artifactId,
    };
  }
}

function publicRow(row: PublicRow): DesignPublicationV1 {
  return DesignPublicationV1Schema.parse({
    version: 1,
    schemaVersion: "design_publication.v1",
    publicationId: row.publication_id,
    publicSlug: row.public_slug,
    releaseDigest: row.source_release_digest,
    manifestDigest: row.manifest_digest,
    safePreviewDigest: row.safe_preview_digest,
    license: row.license,
    attribution: row.attribution,
    state: row.state,
  });
}

function tokenHash(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function requireNonblank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new DesignEcosystemError("blocked", `${label} missing`);
}

function ecosystemError(code: "not_found" | "conflict" | "blocked", detail: string): DesignEcosystemError {
  return new DesignEcosystemError(code, detail);
}
