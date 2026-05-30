import { z } from "zod";

/**
 * Allocator kinds the selector understands. `static` / `sidecar` are the
 * existing dev/prod allocators; `manual_ssh` / `hetzner` / `digitalocean` /
 * `gcp` / `aws_ec2` / `kubernetes` are all real cloud implementations. Stored in
 * project config (JSONB) and/or supplied via env — no schema migration is
 * required because we reuse the existing `projects.config` column.
 */
export const AllocatorKind = z.enum([
  "static",
  "sidecar",
  "manual_ssh",
  "hetzner",
  "digitalocean",
  "gcp",
  "aws_ec2",
  "kubernetes",
]);
export type AllocatorKind = z.infer<typeof AllocatorKind>;

/**
 * Pool policy for a given allocator kind. Caps how many runners may be in
 * flight at once and whether targets are reused (long-lived pool) or treated
 * as ephemeral (provisioned per run and destroyed on release). The selector
 * enforces `maxConcurrent`; `reuse` is metadata the allocator implementation
 * already encodes (manual-ssh reuses hosts; hetzner is ephemeral).
 */
export const PoolPolicy = z
  .object({
    /** Max concurrent in-flight runners for this kind. Omit for unbounded. */
    maxConcurrent: z.number().int().min(1).optional(),
    /** true = reuse long-lived targets; false = ephemeral, destroy on release. */
    reuse: z.boolean().default(false),
  })
  .strict();
export type PoolPolicy = z.infer<typeof PoolPolicy>;

/**
 * A label-routing rule: if a run carries every label in `matchLabels` (exact
 * value match), route it to `allocator`. Rules are evaluated in order; the
 * first match wins. A run with no matching rule falls back to the router's
 * default kind.
 */
export const LabelRoutingRule = z
  .object({
    matchLabels: z.record(z.string(), z.string()),
    allocator: AllocatorKind,
  })
  .strict();
export type LabelRoutingRule = z.infer<typeof LabelRoutingRule>;

/**
 * The routing configuration the selector consumes. Self-contained so it can be
 * persisted in `projects.config` JSONB without a migration, or built from env
 * in `main.ts`.
 */
export const AllocatorRoutingConfig = z
  .object({
    /** Kind used when no label rule matches. */
    defaultAllocator: AllocatorKind,
    /** Ordered label-routing rules; first match wins. */
    rules: z.array(LabelRoutingRule).default([]),
    /** Per-kind pool policies. Kinds absent here are unbounded + ephemeral. */
    pools: z.partialRecord(AllocatorKind, PoolPolicy).default({}),
  })
  .strict();
export type AllocatorRoutingConfig = z.infer<typeof AllocatorRoutingConfig>;

/**
 * Picks the allocator kind for a run given its labels. First rule whose
 * `matchLabels` are all satisfied wins; otherwise the default kind.
 */
export function selectAllocatorKind(
  config: AllocatorRoutingConfig,
  labels: Readonly<Record<string, string>>,
): AllocatorKind {
  for (const rule of config.rules) {
    if (matchesAllLabels(rule.matchLabels, labels)) {
      return rule.allocator;
    }
  }
  return config.defaultAllocator;
}

function matchesAllLabels(
  required: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): boolean {
  for (const [key, value] of Object.entries(required)) {
    if (actual[key] !== value) {
      return false;
    }
  }
  return true;
}

/** Error raised when a kind's pool policy `maxConcurrent` cap is reached. */
export class PoolCapacityExceededError extends Error {
  constructor(
    public readonly kind: AllocatorKind,
    public readonly maxConcurrent: number,
  ) {
    super(`allocator pool '${kind}' at capacity: ${maxConcurrent} concurrent runner(s) in flight`);
    this.name = "PoolCapacityExceededError";
  }
}
