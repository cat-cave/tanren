// spec discovery: provenance, stored on the spec record.
//
// Provenance answers "which insight produced this spec, and how was it placed?"
// It is 1:1 with a spec, so rather than a bespoke `spec_provenance` table it
// lives under the `discovery` key of `specs.metadata` (JSONB, migration 0023).
// This keeps the lineage co-located with the spec it explains and adds no join.
//
//   specs.metadata = { "discovery": { <DiscoveryProvenance> }, ... }
//
// `parseDiscoveryProvenance` / `writeProvenance` are the only touch-points; both
// round-trip through the strict schema so a malformed legacy blob degrades to
// `undefined` rather than throwing on read.

import type pg from "pg";
import { z } from "zod";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import { systemActor } from "../../state/actor.js";
import { DiscoveryStore } from "../../repositories/discovery.js";
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
    discoveredAt: z.string(),
  })
  .strict();
export type DiscoveryProvenance = z.infer<typeof DiscoveryProvenance>;

// Build a metadata blob carrying the discovery provenance under its key,
// preserving any pre-existing metadata fields.
export function withDiscoveryProvenance(
  existing: Record<string, unknown> | null | undefined,
  provenance: DiscoveryProvenance,
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
  provenance: DiscoveryProvenance,
): Promise<boolean> {
  const current = await DiscoveryStore.getSpecMetadata(client, specId, systemActor);
  if (!current.found) {
    return false;
  }
  const next = withDiscoveryProvenance(current.metadata as Record<string, unknown> | null, provenance);
  return DiscoveryStore.setSpecMetadata(client, specId, JSON.stringify(next), systemActor);
}

/**
 * Plane-split (autonomy loops): the control-plane variant of {@link writeProvenance}.
 * The READ (current metadata, a SELECT the data plane keeps) runs in-process on the
 * org-scoped pool; only the WRITE — the `UPDATE specs SET metadata` the de-privileged
 * data plane can no longer run directly (migration 0035) — routes through the
 * control-plane writer's `setSpecMetadata`, carrying the explicit org. WHAT GETS
 * WRITTEN is byte-identical (the same merged blob); only WHERE the UPDATE runs moves.
 */
export async function writeProvenanceViaWriter(
  readClient: QueryClient,
  writer: RunStateWriter,
  orgId: string,
  specId: string,
  provenance: DiscoveryProvenance,
): Promise<boolean> {
  const current = await DiscoveryStore.getSpecMetadata(readClient, specId, systemActor);
  if (!current.found) {
    return false;
  }
  const next = withDiscoveryProvenance(current.metadata as Record<string, unknown> | null, provenance);
  await writer.setSpecMetadata({ specId, orgId, metadataJson: JSON.stringify(next) });
  return true;
}
