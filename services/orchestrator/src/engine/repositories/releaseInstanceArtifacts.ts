// The release row's artifact FK is non-null. Provider deployments expose an
// immutable digest before their bytes are available to the local CAS reader, so
// record that provider-owned object as a durable CAS reference before inserting
// the release row. A later byte ingestion may replace this reference with the
// actual object; the digest (and therefore the release lineage) is unchanged.

import type pg from "pg";
import type { Digest, ProviderChecksum } from "../contracts/cas.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface ReleaseArtifactReference {
  orgId: string;
  provider: string;
  appId: string;
  deploymentId: string;
  artifactDigest: Digest;
  providerChecksum: ProviderChecksum | null;
}

export async function ensureReleaseArtifact(client: QueryClient, input: ReleaseArtifactReference): Promise<void> {
  await client.query(
    `INSERT INTO cas_artifacts
       (org_id, digest, byte_size, media_type, storage_backend, storage_key,
        inline_bytes, provider_checksum, encryption_state, retention_class)
     VALUES ($1, $2, 0, 'application/vnd.tanren.provider-artifact-reference+json',
             'object_store', $3, NULL, $4, 'none', 'standard')
     ON CONFLICT (org_id, digest) DO NOTHING`,
    [
      input.orgId,
      input.artifactDigest,
      `provider-artifact/${input.provider}/${input.appId}/${input.deploymentId}`,
      input.providerChecksum,
    ],
  );
}
