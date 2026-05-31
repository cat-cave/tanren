import { z } from "zod";
import { ManagedProviderConfig, ProviderMode } from "./managedProvider.js";
import {
  GovernancePosture,
  MergeIntegration,
  NotificationTargetRef,
  PartialAllocatorConfig,
  PartialEscapeHatches,
  PartialForgePersona,
  MissingConfigVersionError,
  RoutingTable,
  UnknownConfigVersionError,
  emptyRoutingTable,
  readObservedVersion,
} from "./shared.js";

// Top-level versioned Zod schema for project-level config. Persisted as a
// JSONB column on `projects.config`. Most fields are partial overrides on
// top of the org-level defaults; the routing table is a full table at the
// project layer because the operator UI renders the merged view per role.

// P3-0002: a project's bound credential references. Both fields are optional;
// a project may bind only one kind and inherit the other from the org default.
export const ProjectCredentialRefs = z
  .object({
    codexCredentialRef: z.string().min(1).optional(),
    githubCredentialRef: z.string().min(1).optional(),
  })
  .strict();
export type ProjectCredentialRefs = z.infer<typeof ProjectCredentialRefs>;

export const ProjectConfigV1 = z
  .object({
    version: z.literal(1),
    // Project-level overrides for the org-level chain. Every role is present
    // with `{ chain: [] }` by default; entries override the org defaults.
    routing: RoutingTable.default(emptyRoutingTable()),
    // Partial because the project layer should only express the budgets it
    // actually wants to deviate on; the org defaults fill the rest.
    escapeHatches: PartialEscapeHatches.default({}),
    allocator: PartialAllocatorConfig.default({}),
    notificationTargets: z.array(NotificationTargetRef).default([]),
    forgePersona: PartialForgePersona.default({}),
    governancePosture: GovernancePosture.default("strict"),
    mergeIntegration: MergeIntegration.default("not_configured"),
    // P3-0025: optional per-project preview-deploy URL pattern. Drives the live
    // preview iframe in the Review surface. Supports `{branch}` and `{pr}`
    // placeholders (e.g. `https://pr-{pr}.preview.fly.dev`). Optional + additive:
    // legacy rows carry no key and parse to an absent field (no migration), and
    // `.strict()` round-trips it untouched on save. The dashboard never writes a
    // preview URL onto runs — it derives one from this pattern at render time.
    previewUrlPattern: z.string().min(1).optional(),
    // P3-0002: optional credential refs the run executor resolves before a run.
    // Backward-compatible — legacy rows carry no `credentials` key and parse to
    // an absent field (the resolver then falls back to the org defaults).
    // Refs are the P2A-0013 managed namespace (`credential/<kind>/<scope>/...`),
    // not vault:// URIs.
    credentials: ProjectCredentialRefs.optional(),
    // SaaS Tier-B #5: optional per-project override of the org's BYOK-vs-managed
    // toggle. Absent ⇒ inherit the org `providerMode` (so legacy rows parse to
    // an absent field and the org default applies — no migration). When set, it
    // wins over the org for this project. `managedProvider` likewise overrides
    // the org's platform credential ref + endpoint for this project only.
    providerMode: ProviderMode.optional(),
    managedProvider: ManagedProviderConfig.optional(),
  })
  .strict();
export type ProjectConfigV1 = z.infer<typeof ProjectConfigV1>;

export const ProjectConfigVersioned = z.discriminatedUnion("version", [ProjectConfigV1]);
export type ProjectConfigVersioned = z.infer<typeof ProjectConfigVersioned>;

export const SUPPORTED_PROJECT_CONFIG_VERSIONS: ReadonlyArray<number> = [1];

// Parses a stored project config row into the typed V1 shape. Strict,
// fail-hard — same rules as `migrateOrgConfig`: a row missing the `version`
// discriminator throws MissingConfigVersionError (no silent versionless→V1
// upgrade). Callers must persist an explicit `version`.
export function migrateProjectConfig(raw: unknown): ProjectConfigV1 {
  const observed = readObservedVersion(raw);
  if (observed === undefined) {
    throw new MissingConfigVersionError(SUPPORTED_PROJECT_CONFIG_VERSIONS);
  }
  if (observed === 1) {
    return ProjectConfigV1.parse(raw);
  }
  throw new UnknownConfigVersionError(observed, SUPPORTED_PROJECT_CONFIG_VERSIONS);
}

export function defaultProjectConfigV1(): ProjectConfigV1 {
  return ProjectConfigV1.parse({ version: 1 });
}

export function projectConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ProjectConfigV1) as Record<string, unknown>;
}
