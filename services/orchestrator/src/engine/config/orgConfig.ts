import { z } from "zod";
import { ProviderMode } from "./managedProvider.js";
import {
  AllocatorConfig,
  CreditRates,
  EscapeHatches,
  ForgePersona,
  NotificationTargetRef,
  ProjectBudget,
  RoutingTable,
  UnknownConfigVersionError,
  emptyRoutingTable,
  readObservedVersion,
} from "./shared.js";
import { DefaultLlmEntry } from "../credentials/defaultLlmEntry.js";

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

// org-level default credentials. A project that binds no credential of a given
// kind inherits the org default. Stored in `organizations.config` JSONB so no
// DB migration is needed. Both keys are optional; an org may default only one.
//
// `defaultLlm` is a provider-agnostic routing entry {cli, model, authRef} — NOT
// a Codex-specific ref. It heads every loop-role chain a project leaves empty,
// so the DEFAULT harness is a DATA fact (codex, claude, or any full-role harness
// with a compatible credential), exactly like a per-role override. `cli` MUST be
// a full-role harness (harnessCanBeDefault) and `authRef`'s credential-type MUST
// be one the cli accepts (harnessAcceptsCredentialType) — both validated where
// the default is SET (the connect route), not here.
export const OrgDefaultCredentials = z
  .object({
    defaultLlm: DefaultLlmEntry.optional(),
    github_token: z.string().min(1).optional(),
  })
  .strict();
export type OrgDefaultCredentials = z.infer<typeof OrgDefaultCredentials>;

// per-org GitHub App installation. When present, the token resolver
// prefers minting an auto-rotating installation token (from the App private
// key stored in Vault under `credentialRef`) over the static `github_token`
// fallback. Persisted in `organizations.config` JSONB — no DB migration. The
// App private key itself never lands here; only the credential *ref* does.
export const OrgGithubAppInstallation = z
  .object({
    installationId: z.string().min(1),
    appId: z.string().min(1),
    credentialRef: z.string().min(1),
    installedAt: z.string().min(1),
  })
  .strict();
export type OrgGithubAppInstallation = z.infer<typeof OrgGithubAppInstallation>;

// tanren-config audit-gate target. When the gate is ON
// (`auditGateEnabled`), Bucket-B config writes (routing/limits) do not apply
// to the DB directly — they are rendered as a `configFile` diff and opened as a
// PR in this separate `repo` (the DB stays source of truth; apply happens on
// PR merge). The whole block lives in `organizations.config` JSONB — there is
// NO dedicated table and NO migration (same pattern as `github_app`). The repo
// is referenced as `owner/name`; `baseBranch` is the PR base, `branchPrefix`
// names the head branch (`<branchPrefix>/<slug>`). `configFile` is the path the
// diff is written to (default `tanren.yaml`).
export const OrgAuditGateTarget = z
  .object({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/u, "expected owner/name"),
    baseBranch: z.string().min(1).default("main"),
    branchPrefix: z.string().min(1).default("forge"),
    configFile: z.string().min(1).default("tanren.yaml"),
  })
  .strict();
export type OrgAuditGateTarget = z.infer<typeof OrgAuditGateTarget>;

export const OrgConfigV1 = z
  .object({
    version: z.literal(1),
    routing: RoutingTable.default(emptyRoutingTable()),
    escapeHatches: EscapeHatches.default(defaultEscapeHatches),
    allocator: AllocatorConfig.default(defaultAllocator),
    notificationTargets: z.array(NotificationTargetRef).default([]),
    forgePersona: ForgePersona.default(defaultForgePersona),
    auditGateEnabled: z.boolean().default(false),
    auditGate: OrgAuditGateTarget.optional(),
    defaultCredentials: OrgDefaultCredentials.optional(),
    github_app: OrgGithubAppInstallation.optional(),
    // SaaS Tier-B #5: the BYOK-vs-managed provider toggle. `byok` (default)
    // resolves the tenant's own credential — unchanged behavior. `managed`
    // resolves the platform-owned credential + endpoint, which are DEPLOY/hosting
    // config (defaultManagedProviderConfig), NOT userland: a tenant chooses the
    // MODE here, but the platform credential ref/endpoint live in the deploy layer
    // (no per-org/project override). Defaults to `byok`; the hosting layer flips it.
    providerMode: ProviderMode.default("byok"),
    // The ORG-LEVEL DEFAULT dollar budget ceiling (autonomy-engine.md §3 proof 6).
    // A project that sets its own `budget` overrides this; a project that omits it
    // inherits this org default (the DagWalker resolves project-over-org). Optional:
    // an absent default means NO org-wide ceiling = unlimited unless a project sets
    // its own.
    defaultBudget: ProjectBudget.optional(),
    // The ORG-LEVEL DEFAULT per-credential credit/overage USD rates (cost PR-C),
    // keyed by credential ref-KIND (see `CreditRates`). A project's own
    // `creditRates` overrides this per kind; a kind only the org configures
    // inherits here (the cost reconcile resolves project-over-org). Defaults to an
    // EMPTY map: NO org-default rate for any kind (a drawdown then lands
    // NULL-and-loud unless the project configures the rate).
    defaultCreditRates: CreditRates.default({}),
  })
  .strict();
export type OrgConfigV1 = z.infer<typeof OrgConfigV1>;

// Versioned wrapper: the persisted shape is a discriminated union over the
// `version` literal so future V2+ definitions can be added without
// re-encoding existing rows. There is only one branch in v0 by design.
export const OrgConfigVersioned = z.discriminatedUnion("version", [OrgConfigV1]);
export type OrgConfigVersioned = z.infer<typeof OrgConfigVersioned>;

export const SUPPORTED_ORG_CONFIG_VERSIONS: ReadonlyArray<number> = [1];

// Parses a stored org config row into the typed V1 shape. Fail-hard, no shim:
//   - missing `version`: throw UnknownConfigVersionError — an unversioned row
//     is a hard error, NOT a silent upgrade to V1 defaults (Tanren has no
//     legacy rows; every persisted config carries an explicit `version`);
//   - `version === 1`: parse as V1 directly;
//   - any other observed version: throw UnknownConfigVersionError.
export function migrateOrgConfig(raw: unknown): OrgConfigV1 {
  const observed = readObservedVersion(raw);
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

/**
 * The org's GitHub App installation from a stored `organizations.config` value,
 * or `undefined` when no App is installed. The single shared implementation the
 * clone / draft-PR / merge / speculative-integrate context loaders
 * call so the clone resolves App-first.
 *
 * No silent fallback (the scoping/credential hardening directive): an ABSENT
 * config (`null`/`undefined`) and a present-but-App-less config both resolve to
 * `undefined` (legitimately "no App"), but a config that is PRESENT yet
 * UNPARSEABLE is a real corruption — `migrateOrgConfig` throws and that throw
 * PROPAGATES, rather than being swallowed to a static/unauthenticated clone.
 */
export function installationFromOrgConfig(orgConfig: unknown): OrgGithubAppInstallation | undefined {
  if (orgConfig === null || orgConfig === undefined) {
    return undefined;
  }
  return migrateOrgConfig(orgConfig).github_app;
}

// The org's DEFAULT per-credential credit/overage USD rates from a stored
// `organizations.config` value (cost PR-C), or an EMPTY map when no org row /
// no rates are configured. The org-default LAYER the run-end credit reconcile
// falls back to under a project's own `creditRates`. Mirrors
// `installationFromOrgConfig`'s no-silent-fallback contract: an absent config is
// legitimately "no org rates" (empty map), but a PRESENT-yet-UNPARSEABLE config
// throws (migrateOrgConfig) rather than being swallowed to a silent empty map.
export function creditRatesFromOrgConfig(orgConfig: unknown): Record<string, number> {
  if (orgConfig === null || orgConfig === undefined) {
    return {};
  }
  return migrateOrgConfig(orgConfig).defaultCreditRates;
}

// Emits a JSON Schema artifact for documentation. Operator UIs and external
// tools should consume the Zod schema directly; the JSON Schema is for human
// reference and for downstream tools that cannot import Zod.
export function orgConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(OrgConfigV1) as Record<string, unknown>;
}
