// P3-0014 spec discovery: provenance, stored on the spec record.
//
// Provenance answers "which insight produced this spec, and how was it placed?"
// It is 1:1 with a spec, so rather than a bespoke `spec_provenance` table it
// lives under the `discovery` key of `specs.metadata` (JSONB, migration 0023).
// This keeps the lineage co-located with the spec it explains and adds no join.
//
//   specs.metadata = { "discovery": { <DiscoveryProvenance> }, ... }
//
// `readProvenance` / `writeProvenance` are the only touch-points; both round-
// trip through the strict schema so a malformed legacy blob degrades to
// `undefined` rather than throwing on read.

import type pg from "pg";
import { z } from "zod";
import { DiscoveryVariant, PlacementKind } from "./types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const DISCOVERY_METADATA_KEY = "discovery" as const;

export const DiscoveryProvenance = z
  .object({
    variant: DiscoveryVariant,
    // Where the insight came from + who/when, copied off the insight card so the
    // spec carries its own origin without re-fetching the (transient) insight.
    insightSource: z.string(),
    insightSourceLabel: z.string(),
    insightWho: z.string(),
    insightWhen: z.string(),
    // A short excerpt of the insight body (capped) for at-a-glance lineage.
    insightExcerpt: z.string(),
    // The DAG-placement the operator accepted.
    placementKind: PlacementKind,
    placementLabel: z.string(),
    // When the spec was forged from this insight (ISO-8601).
    discoveredAt: z.string()
  })
  .strict();
export type DiscoveryProvenance = z.infer<typeof DiscoveryProvenance>;

// Build a metadata blob carrying the discovery provenance under its key,
// preserving any pre-existing metadata fields.
export function withDiscoveryProvenance(
  existing: Record<string, unknown> | null | undefined,
  provenance: DiscoveryProvenance
): Record<string, unknown> {
  const base = existing !== null && typeof existing === "object" ? existing : {};
  return { ...base, [DISCOVERY_METADATA_KEY]: provenance };
}

// Parse the discovery provenance off a raw metadata value. Returns undefined
// when absent or malformed.
export function parseDiscoveryProvenance(metadata: unknown): DiscoveryProvenance | undefined {
  if (metadata === null || typeof metadata !== "object") {
    return undefined;
  }
  const candidate = (metadata as Record<string, unknown>)[DISCOVERY_METADATA_KEY];
  const parsed = DiscoveryProvenance.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

// Persist provenance onto the spec row's metadata JSONB (merging with any
// existing metadata). Returns false when the spec does not exist.
export async function writeProvenance(
  client: QueryClient,
  specId: string,
  provenance: DiscoveryProvenance
): Promise<boolean> {
  const current = await client.query<{ metadata: unknown }>(
    "SELECT metadata FROM specs WHERE spec_id = $1",
    [specId]
  );
  if ((current.rowCount ?? 0) === 0) {
    return false;
  }
  const existing = current.rows[0]?.metadata;
  const next = withDiscoveryProvenance(existing as Record<string, unknown> | null, provenance);
  const updated = await client.query(
    "UPDATE specs SET metadata = $2::jsonb WHERE spec_id = $1 RETURNING spec_id",
    [specId, JSON.stringify(next)]
  );
  return (updated.rowCount ?? 0) > 0;
}

// Read the discovery provenance for a spec. Returns undefined when the spec has
// none (or does not exist).
export async function readProvenance(
  client: QueryClient,
  specId: string
): Promise<DiscoveryProvenance | undefined> {
  const result = await client.query<{ metadata: unknown }>(
    "SELECT metadata FROM specs WHERE spec_id = $1",
    [specId]
  );
  if ((result.rowCount ?? 0) === 0) {
    return undefined;
  }
  return parseDiscoveryProvenance(result.rows[0]?.metadata);
}
