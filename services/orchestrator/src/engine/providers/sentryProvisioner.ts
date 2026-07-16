// the Sentry IntegrationProvisioner — the concrete proof of the
// `IntegrationProvisioner` port (the keystone of Plane A). It implements the
// "Sentry concrete model" of docs/operator-guide/integration-provisioning.md:
// from an org-level Sentry token grant, Tanren DISCOVERS the org's existing
// projects, PROVISIONS (idempotent find-or-create) a Sentry project under the
// configured team + a client key/DSN, and BINDS an existing project — emitting a
// uniform `ProvisionedArtifact` over the EXISTING project surfaces (projectConfig
// → projects.config; secretRefs → secret manager; inboxSource → inbox_sources).
// No migration; no new DB surface.
//
// SEAM SHAPE — like `GitHubVcsProvider`: a REAL impl over an INJECTABLE HTTP
// transport (`SentryHttpClient`) so it is unit-testable against a scripted/fake
// transport — there is NEVER a live Sentry API call in CI. The DSN it mints is
// written to the injected `SecretStore` (the secret manager) and the artifact
// carries only the secret REF, never the DSN value. The DSN is a Plane-A project
// artifact secret (Tanren's intake DSN), distinct from Plane-B app env.
//
// REQUIRED SENTRY TOKEN SCOPES — this is a PROVISIONING token, not an intake one.
// `discover` needs `project:read`; `provision`/`bind` CREATE resources and need
// `project:write` (create project under a team) + `project:admin` (create/read a
// project client key/DSN). `team:read` is needed if the configured team must be
// resolved. The runtime `sentryConnector` (intake) needs only `event:read` /
// `project:read` — a strictly narrower set. Document this for the operator when
// they link the org connection and its control grant.
//
// IDEMPOTENCY (mandatory, per the port contract): `provision` finds the existing
// project whose slug matches the stable Tanren-derived slug and reuses it; a
// second `provision` for the same project never creates a second Sentry project
// (asserted by the conformance suite). The client key is likewise find-or-create:
// an existing key's DSN is reused rather than minting a duplicate.

import type { SecretStore } from "../contracts/secretStore.js";
import type {
  CapabilityId,
  ExistingResource,
  IntegrationProvisioner,
  OrgGrant,
  ProjectContext,
  ProvisionedArtifact,
} from "../contracts/integrationProvisioner.js";

/**
 * The injectable Sentry transport for provisioning. Mirrors the runtime
 * `sentryConnector`'s `SentryHttpClient` but adds the write verb (`POST`) the
 * provisioner needs to create projects + client keys. `path` is API-root-relative
 * (`/api/0/...`); `token` is the resolved org grant token; `baseUrl` defaults to
 * Sentry SaaS but is overridable for self-hosted. A scripted fake of this seam is
 * what the conformance suite drives — no live Sentry call in CI.
 */
export interface SentryProvisionHttpRequest {
  method: "GET" | "POST";
  path: string;
  token: string;
  baseUrl: string;
  body?: unknown;
}

export interface SentryProvisionHttpResponse {
  status: number;
  body: unknown;
}

export interface SentryProvisionHttpClient {
  request(input: SentryProvisionHttpRequest): Promise<SentryProvisionHttpResponse>;
}

/**
 * The production transport: a thin fetch wrapper that sends the Sentry auth token
 * as a Bearer header and JSON body for writes. Injectable `fetchImpl` keeps it
 * testable; the provisioner's own tests inject a fake `SentryProvisionHttpClient`
 * directly so no network/token is touched.
 */
export class FetchSentryProvisionHttpClient implements SentryProvisionHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async request(input: SentryProvisionHttpRequest): Promise<SentryProvisionHttpResponse> {
    const response = await this.fetchImpl(`${input.baseUrl.replace(/\/$/u, "")}${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/json",
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  }
}

/**
 * The injected wiring `buildIntegrationProvisioner('sentry', { sentry })` threads
 * in: the HTTP transport the impl composes + the SecretStore the DSN is written
 * to. The org grant token + metadata are passed per-call (not here).
 */
export interface SentryProvisionerDeps {
  http: SentryProvisionHttpClient;
  secrets: SecretStore;
}

/** The default Sentry SaaS API root. Self-hosted overrides via the grant metadata. */
const DEFAULT_SENTRY_BASE_URL = "https://sentry.io";
/** The capability the matrix names for an error-tracking source. */
const CAPABILITY_ERRORS = "errors";

/** The non-secret org metadata a Sentry grant carries. `orgSlug` is mandatory. */
interface SentryGrantMetadata {
  orgSlug: string;
  /** The Sentry team slug new projects are created under (provision/create path). */
  team?: string;
  /** Self-hosted API root override; defaults to Sentry SaaS. */
  baseUrl?: string;
}

/** A Sentry project as the org-projects list / create endpoints return it. */
interface RawSentryProject {
  slug?: unknown;
  name?: unknown;
  platform?: unknown;
}

/** A Sentry client key (DSN) as the keys endpoints return it. */
interface RawSentryKey {
  id?: unknown;
  dsn?: { public?: unknown } | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Map a Tanren stack to the Sentry `platform` for a newly created project. A
 * conservative correspondence — anything unrecognized falls to `other`, which
 * Sentry always accepts (the platform only tunes onboarding hints, never gating
 * intake). NEVER throws: an unknown stack must not block provisioning.
 */
function platformFromStack(stack: string | undefined): string {
  switch ((stack ?? "").toLowerCase()) {
    case "node":
    case "express":
      return "node";
    case "next":
    case "nextjs":
      return "javascript-nextjs";
    case "react":
      return "javascript-react";
    case "python":
    case "django":
    case "flask":
      return "python";
    case "go":
      return "go";
    case "ruby":
    case "rails":
      return "ruby";
    default:
      return "other";
  }
}

/**
 * Derive the STABLE Sentry project slug from the Tanren project. This is the
 * idempotency key: `provision` finds an existing project by this slug before
 * creating one, so re-running onboarding never mints a duplicate. Lower-cased,
 * non-slug chars collapsed to `-`, trimmed — Sentry slugs are lower-kebab.
 */
function stableProjectSlug(ctx: ProjectContext): string {
  const source = (ctx.name ?? ctx.projectId).toLowerCase();
  const slug = source
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 50);
  return slug.length > 0 ? slug : `tanren-${ctx.projectId}`;
}

/**
 * The secret-manager ref the DSN is stored under: org- and project-scoped so two
 * projects' DSNs never collide and the ref can be rebuilt from the artifact.
 * This is a Plane-A project-artifact secret path (Tanren's intake DSN).
 */
function dsnSecretRef(orgId: string, projectSlug: string): string {
  return `org/${orgId}/sentry/${projectSlug}/dsn`;
}

function readGrantMetadata(grant: OrgGrant): SentryGrantMetadata {
  const metadata = grant.metadata as Partial<SentryGrantMetadata>;
  const orgSlug = asString(metadata.orgSlug);
  if (orgSlug === undefined) {
    throw new Error("sentry provisioner: grant metadata is missing the required `orgSlug`");
  }
  return { orgSlug, team: asString(metadata.team), baseUrl: asString(metadata.baseUrl) };
}

/**
 * The Sentry implementation of {@link IntegrationProvisioner}. Constructed with
 * the injectable `SentryProvisionHttpClient` transport + the `SecretStore` the
 * DSN is written to — both injected so the impl is exercised against a scripted
 * fake transport + in-memory store with no live Sentry call. The org grant
 * (token via the SecretStore ref + org metadata) is passed per-call.
 */
export class SentryProvisioner implements IntegrationProvisioner {
  constructor(
    private readonly http: SentryProvisionHttpClient,
    private readonly secrets: SecretStore,
  ) {}

  capability(): CapabilityId[] {
    return [CAPABILITY_ERRORS];
  }

  async discover(grant: OrgGrant): Promise<ExistingResource[]> {
    const meta = readGrantMetadata(grant);
    const token = await this.resolveToken(grant);
    const projects = await this.listOrgProjects(meta, token);
    return projects.map((project) => {
      const slug = asString(project.slug) ?? "";
      return {
        id: slug,
        label: asString(project.name) ?? slug,
        metadata: { slug, platform: asString(project.platform) },
      };
    });
  }

  async provision(grant: OrgGrant, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const meta = readGrantMetadata(grant);
    const token = await this.resolveToken(grant);
    const desiredSlug = stableProjectSlug(projectCtx);

    // Find-or-create keyed on the stable slug (idempotency): a second provision
    // for the same project reuses the existing project, never mints a duplicate.
    const existing = await this.findProjectBySlug(meta, token, desiredSlug);
    const slug = existing === undefined ? await this.createProject(meta, token, desiredSlug, projectCtx) : existing;

    return this.artifactFor(grant, meta, token, slug);
  }

  async bind(grant: OrgGrant, existingResourceId: string, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const meta = readGrantMetadata(grant);
    const token = await this.resolveToken(grant);
    // Verify the resource exists before binding — never bind a phantom (the
    // contract requires bind of an unknown id to reject, no silent success).
    const found = await this.findProjectBySlug(meta, token, existingResourceId);
    if (found === undefined) {
      throw new Error(`sentry provisioner: cannot bind unknown project '${existingResourceId}'`);
    }
    return this.artifactFor(grant, meta, token, found, projectCtx);
  }

  /**
   * Resolve the org grant's token from the SecretStore by its ref. The token is
   * read here and passed down to the transport per request; it is NEVER returned
   * in the artifact, logged, or persisted to DB config.
   */
  private async resolveToken(grant: OrgGrant): Promise<string> {
    // Exact generation only — never naked SecretStore.get of a non-generation ref.
    const { GenerationAddressedIntegrationSecretStore } = await import("../integrations/integrationSecretStoreImpl.js");
    const { secretValueForLease } = await import("../repositories/integrationConnectionResolve.js");
    return secretValueForLease(new GenerationAddressedIntegrationSecretStore(this.secrets), grant.eligibleOperation);
  }

  private async listOrgProjects(meta: SentryGrantMetadata, token: string): Promise<RawSentryProject[]> {
    const response = await this.http.request({
      method: "GET",
      path: `/api/0/organizations/${encodeURIComponent(meta.orgSlug)}/projects/`,
      token,
      baseUrl: this.baseUrl(meta),
    });
    if (response.status !== 200 || !Array.isArray(response.body)) {
      throw new Error(`sentry provisioner: list org projects failed: HTTP ${response.status}`);
    }
    return response.body as RawSentryProject[];
  }

  private async findProjectBySlug(meta: SentryGrantMetadata, token: string, slug: string): Promise<string | undefined> {
    const projects = await this.listOrgProjects(meta, token);
    const match = projects.find((project) => asString(project.slug) === slug);
    return match === undefined ? undefined : slug;
  }

  /** Create a Sentry project under the configured team (platform from the stack). */
  private async createProject(
    meta: SentryGrantMetadata,
    token: string,
    slug: string,
    projectCtx: ProjectContext,
  ): Promise<string> {
    if (meta.team === undefined) {
      throw new Error(
        "sentry provisioner: grant metadata is missing `team` — a Sentry team is required to create a project",
      );
    }
    const response = await this.http.request({
      method: "POST",
      path: `/api/0/teams/${encodeURIComponent(meta.orgSlug)}/${encodeURIComponent(meta.team)}/projects/`,
      token,
      baseUrl: this.baseUrl(meta),
      body: {
        name: projectCtx.name ?? slug,
        slug,
        platform: platformFromStack(projectCtx.stack),
      },
    });
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`sentry provisioner: create project '${slug}' failed: HTTP ${response.status}`);
    }
    // Prefer the slug Sentry actually assigned (it may normalize on collision).
    const created = response.body as RawSentryProject | undefined;
    return asString(created?.slug) ?? slug;
  }

  /**
   * Ensure a client key/DSN for the project (find-or-create) and return the
   * public DSN value. Reuses an existing key's DSN rather than minting a second.
   */
  private async ensureDsn(meta: SentryGrantMetadata, token: string, slug: string): Promise<string> {
    const keysPath = `/api/0/projects/${encodeURIComponent(meta.orgSlug)}/${encodeURIComponent(slug)}/keys/`;
    const list = await this.http.request({
      method: "GET",
      path: keysPath,
      token,
      baseUrl: this.baseUrl(meta),
    });
    if (list.status === 200 && Array.isArray(list.body) && list.body.length > 0) {
      const dsn = dsnFromKey(list.body[0] as RawSentryKey);
      if (dsn !== undefined) {
        return dsn;
      }
    }
    // None usable — create one.
    const created = await this.http.request({
      method: "POST",
      path: keysPath,
      token,
      baseUrl: this.baseUrl(meta),
      body: { name: "tanren-intake" },
    });
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(`sentry provisioner: create client key for '${slug}' failed: HTTP ${created.status}`);
    }
    const dsn = dsnFromKey(created.body as RawSentryKey);
    if (dsn === undefined) {
      throw new Error(`sentry provisioner: client key for '${slug}' returned no DSN`);
    }
    return dsn;
  }

  /**
   * Build the uniform artifact for a (possibly just-created) project: store the
   * DSN in the secret manager and emit ONLY its ref + the projectConfig + the
   * `inbox_sources` row referencing the project slug and the org token ref. The
   * DSN VALUE never appears in the returned artifact.
   */
  private async artifactFor(
    grant: OrgGrant,
    meta: SentryGrantMetadata,
    token: string,
    slug: string,
    projectCtx?: ProjectContext,
  ): Promise<ProvisionedArtifact> {
    const dsn = await this.ensureDsn(meta, token, slug);
    const metaOrgId = (grant.metadata as { orgId?: unknown }).orgId;
    const orgId = projectCtx?.orgId ?? (typeof metaOrgId === "string" ? metaOrgId : meta.orgSlug);
    const ref = dsnSecretRef(orgId, slug);
    // The DSN → secret manager (managed cred ref), never DB/log/artifact value.
    await this.secrets.put({ ref, value: dsn });
    return {
      projectConfig: { sentryProjectSlug: slug },
      secretRefs: { SENTRY_DSN: ref },
      // The inbox_sources row the runtime `sentryConnector` consumes: it carries
      // the Sentry org + project slug and the ORG TOKEN REF (intake reuses the
      // same org grant credential) — never a token value. `kind: "errors"` is the
      // source-kind the connector map registers Sentry under (connectorMap.ts) AND
      // the only Sentry-valid value in `inbox_sources_kind_check` (migration 0024;
      // the set is issues|errors|system|manual|scheduled_audit). Emitting "sentry"
      // would both violate the CHECK on insert and never resolve a connector.
      inboxSource: {
        kind: "errors",
        config: {
          org: meta.orgSlug,
          project: slug,
          tokenRef: grant.eligibleOperation.credentialRef,
          baseUrl: this.baseUrl(meta),
        },
      },
    };
  }

  private baseUrl(meta: SentryGrantMetadata): string {
    return meta.baseUrl ?? DEFAULT_SENTRY_BASE_URL;
  }
}

function dsnFromKey(key: RawSentryKey | undefined): string | undefined {
  return asString(key?.dsn?.public);
}
