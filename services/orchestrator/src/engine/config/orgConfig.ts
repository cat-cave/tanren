import { z } from "zod";
import {
  AllocatorConfig,
  EscapeHatches,
  ForgePersona,
  NotificationTargetRef,
  RoutingTable,
  UnknownConfigVersionError,
  emptyRoutingTable,
  readObservedVersion
} from "./shared.js";

// Top-level versioned Zod schema for org-level config. Persisted as a JSONB
// column on `organizations.config`. Projects inherit these values unless they
// override a specific field at their own layer (see ProjectConfigV1).

// Default factories: Zod 4 requires defaults that match the resolved type,
// so we feed an empty `{}` through each sub-parser to materialize the fully
// defaulted shape rather than letting the outer object accept a partial
// literal.
const defaultEscapeHatches = () => EscapeHatches.parse({});
const defaultAllocator = () => AllocatorConfig.parse({});
const defaultForgePersona = () => ForgePersona.parse({});

// P3-0002: org-level default credential refs, keyed by P2A-0013 credential
// kind. A project that binds no credential of a given kind inherits the org
// default. Stored in `organizations.config` JSONB so no DB migration is needed.
// Both keys are optional; an org may default only one kind.
export const OrgDefaultCredentials = z
  .object({
    codex_chatgpt_auth: z.string().min(1).optional(),
    github_token: z.string().min(1).optional()
  })
  .strict();
export type OrgDefaultCredentials = z.infer<typeof OrgDefaultCredentials>;

export const OrgConfigV1 = z
  .object({
    version: z.literal(1),
    routing: RoutingTable.default(emptyRoutingTable()),
    escapeHatches: EscapeHatches.default(defaultEscapeHatches),
    allocator: AllocatorConfig.default(defaultAllocator),
    notificationTargets: z.array(NotificationTargetRef).default([]),
    forgePersona: ForgePersona.default(defaultForgePersona),
    auditGateEnabled: z.boolean().default(false),
    defaultCredentials: OrgDefaultCredentials.optional()
  })
  .strict();
export type OrgConfigV1 = z.infer<typeof OrgConfigV1>;

// Versioned wrapper: the persisted shape is a discriminated union over the
// `version` literal so future V2+ definitions can be added without
// re-encoding existing rows. There is only one branch in v0 by design.
export const OrgConfigVersioned = z.discriminatedUnion("version", [OrgConfigV1]);
export type OrgConfigVersioned = z.infer<typeof OrgConfigVersioned>;

export const SUPPORTED_ORG_CONFIG_VERSIONS: ReadonlyArray<number> = [1];

// Parses a stored org config row into the typed V1 shape. Rules:
//   - missing `version` (legacy Phase 1 row, plain `{}` jsonb): treat as V1
//     and let the schema defaults fill in every field;
//   - `version === 1`: parse as V1 directly;
//   - any other observed version: throw UnknownConfigVersionError so callers
//     can decide between refuse-start, warn-and-default, or out-of-process
//     migration.
export function migrateOrgConfig(raw: unknown): OrgConfigV1 {
  const observed = readObservedVersion(raw);
  if (observed === undefined) {
    return OrgConfigV1.parse({ version: 1 });
  }
  if (observed === 1) {
    return OrgConfigV1.parse(raw);
  }
  throw new UnknownConfigVersionError(observed, SUPPORTED_ORG_CONFIG_VERSIONS);
}

// Convenience: produces a fully-defaulted V1 config. Useful for seed data,
// tests, and the initial row written by the auth bootstrap when a new
// organization is created.
export function defaultOrgConfigV1(): OrgConfigV1 {
  return OrgConfigV1.parse({ version: 1 });
}

// Emits a JSON Schema artifact for documentation. Operator UIs and external
// tools should consume the Zod schema directly; the JSON Schema is for human
// reference and for downstream tools that cannot import Zod.
export function orgConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(OrgConfigV1) as Record<string, unknown>;
}
