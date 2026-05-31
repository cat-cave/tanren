import { createHash, randomBytes, randomUUID } from "node:crypto";
import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type {
  ActorContext,
  ActorScope,
  IdentityClaims,
  IdentityOrgClaim,
  Org,
  OrgMemberRole,
  ProjectMemberRole,
  Session,
  TokenScope,
  User,
} from "./schemas.js";

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface UpsertIdentityResult {
  user: User;
  orgs: Org[];
  primaryOrgId: string | null;
}

export interface CreateSessionOptions {
  ttlMs?: number;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreateApiTokenResult {
  id: string;
  rawToken: string;
  tokenHash: string;
}

export class IdentityStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsertIdentity(provider: User["provider"], claims: IdentityClaims): Promise<UpsertIdentityResult> {
    const user = await this.upsertUser(provider, claims);
    const orgs: Org[] = [];
    let primaryOrgId: string | null = null;
    for (const claim of claims.orgs) {
      const org = await this.upsertOrg(claim);
      const role = await this.ensureOrgMembership(org.id, user.id);
      orgs.push(org);
      if (primaryOrgId === null || role === "admin") {
        primaryOrgId = org.id;
      }
    }
    return { user, orgs, primaryOrgId };
  }

  async upsertUser(provider: User["provider"], claims: IdentityClaims): Promise<User> {
    const existing = await this.pool.query("SELECT * FROM users WHERE provider = $1 AND provider_subject = $2", [
      provider,
      claims.providerSubject,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0] as UserRow;
      await this.pool.query(
        "UPDATE users SET login = $1, email = $2, display_name = $3, updated_at = now() WHERE id = $4",
        [claims.login, claims.email, claims.displayName, row.id],
      );
      return rowToUser({
        ...row,
        login: claims.login,
        email: claims.email,
        display_name: claims.displayName,
      });
    }
    const id = `user_${randomUUID()}`;
    const inserted = await this.pool.query<UserRow>(
      `INSERT INTO users (id, provider, provider_subject, login, email, display_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, provider, claims.providerSubject, claims.login, claims.email, claims.displayName],
    );
    return rowToUser(firstRow(inserted.rows));
  }

  // RLS R3b: org creation is a tenant BOOTSTRAP that precedes any org scope —
  // signup/dev-login/onboarding mint an org before an `app.current_org_id` can
  // exist. Under enforced policies the runtime `tanren_app` role (NOBYPASSRLS)
  // with an empty GUC would have its `organizations` INSERT rejected by the
  // deny-by-default WITH CHECK (42501), and even the existence SELECT would
  // return zero rows. So this upsert runs on the BYPASSRLS `tanren_system` pool
  // via `runWithSystemScope` (the same classification as `createProject` seeding
  // and the worker's cross-org `job_queue` claim). When no system pool is
  // configured (single-role dev/CI/tests) it falls back to the passed pool —
  // behavior-identical, since without policies the app role already sees every
  // row. READS of an existing org stay under RLS elsewhere; only this
  // bootstrap-creation write bypasses.
  async upsertOrg(claim: IdentityOrgClaim): Promise<Org> {
    return runWithSystemScope(this.pool, async (client) => {
      const existing = await client.query<OrgRow>("SELECT * FROM organizations WHERE kind = $1 AND external_id = $2", [
        claim.kind,
        claim.externalId,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        const row = firstRow(existing.rows);
        await client.query("UPDATE organizations SET login = $1, display_name = $2, updated_at = now() WHERE id = $3", [
          claim.login,
          claim.displayName,
          row.id,
        ]);
        return rowToOrg({ ...row, login: claim.login, display_name: claim.displayName });
      }
      const id = `org_${randomUUID()}`;
      const inserted = await client.query<OrgRow>(
        `INSERT INTO organizations (id, kind, external_id, login, display_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, claim.kind, claim.externalId, claim.login, claim.displayName],
      );
      return rowToOrg(firstRow(inserted.rows));
    });
  }

  // RLS R3b: membership creation also precedes org scope — the first member is
  // minted alongside the bootstrap org, before any `app.current_org_id`. The
  // `org_members` table is RLS-enabled (deny-by-default), so this read+insert
  // runs on the BYPASSRLS `tanren_system` pool for the same reason as
  // `upsertOrg`. Falls back to the passed pool when no system pool is configured.
  async ensureOrgMembership(orgId: string, userId: string): Promise<OrgMemberRole> {
    return runWithSystemScope(this.pool, async (client) => {
      const existing = await client.query<{ role: OrgMemberRole }>(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        [orgId, userId],
      );
      if ((existing.rowCount ?? 0) > 0) {
        return firstRow(existing.rows).role;
      }
      const countResult = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM org_members WHERE org_id = $1",
        [orgId],
      );
      const isFirst = countResult.rows[0]?.count === "0";
      const role: OrgMemberRole = isFirst ? "admin" : "member";
      await client.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)", [orgId, userId, role]);
      return role;
    });
  }

  async createSession(userId: string, options: CreateSessionOptions = {}): Promise<Session> {
    const id = randomBytes(32).toString("hex");
    const csrfToken = randomBytes(32).toString("hex");
    const ttl = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    const expiresAt = new Date(this.now().getTime() + ttl);
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, csrf_token, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, csrfToken, expiresAt, options.ip ?? null, options.userAgent ?? null],
    );
    return {
      id,
      userId,
      csrfToken,
      expiresAt,
      createdAt: this.now(),
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
    };
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const result = await this.pool.query<SessionRow>("SELECT * FROM sessions WHERE id = $1", [id]);
    if ((result.rowCount ?? 0) === 0) {
      return undefined;
    }
    const row = firstRow(result.rows);
    const session = rowToSession(row);
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      await this.deleteSession(id);
      return undefined;
    }
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  }

  async createApiToken(input: {
    userId: string;
    name: string;
    scopes: TokenScope[];
    expiresAt?: Date | null;
  }): Promise<CreateApiTokenResult> {
    const id = `tok_${randomUUID()}`;
    const rawToken = `tnt_${randomBytes(24).toString("hex")}`;
    const tokenHash = hashApiToken(rawToken);
    await this.pool.query(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.userId, input.name, tokenHash, input.scopes, input.expiresAt ?? null],
    );
    return { id, rawToken, tokenHash };
  }

  async findApiTokenByRaw(rawToken: string): Promise<
    | {
        userId: string;
        scopes: TokenScope[];
        expiresAt: Date | null;
      }
    | undefined
  > {
    const tokenHash = hashApiToken(rawToken);
    const result = await this.pool.query<ApiTokenRow>("SELECT * FROM api_tokens WHERE token_hash = $1", [tokenHash]);
    if ((result.rowCount ?? 0) === 0) {
      return undefined;
    }
    const row = firstRow(result.rows);
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= this.now().getTime()) {
      return undefined;
    }
    await this.pool.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [row.id]);
    return {
      userId: row.user_id,
      scopes: (row.scopes ?? []) as TokenScope[],
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
    };
  }

  // RLS HTTP-route scoping: the auth middleware's "actor's single org" fallback.
  // When a request addresses no org (no `orgs` path segment, no resolvable
  // resource id) the middleware scopes to the actor's org ONLY when the user
  // belongs to exactly one — an unambiguous default that never widens access.
  // This is a user-scoped membership read that PRECEDES any org scope (it is how
  // the middleware discovers the org to scope to), so — like `resolveActorContext`
  // and `ensureOrgMembership` — it runs on the BYPASSRLS `tanren_system` pool,
  // filtered by `user_id`. Returns the sole org id, or `undefined` when the user
  // has zero or more-than-one org (ambiguous → no implicit scope).
  async resolveSoleOrgForUser(userId: string): Promise<string | undefined> {
    const rows = await runWithSystemScope(this.pool, (client) =>
      client.query<{ org_id: string }>("SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 2", [userId]),
    );
    return rows.rowCount === 1 ? rows.rows[0]?.org_id : undefined;
  }

  async resolveActorContext(input: {
    userId: string;
    orgId?: string | null;
    projectId?: string | null;
    source: ActorContext["source"];
    platformAdminUserIds?: ReadonlySet<string>;
  }): Promise<ActorContext> {
    const scopes = new Set<ActorScope>();
    if (input.platformAdminUserIds?.has(input.userId) === true) {
      scopes.add("platform:admin");
    }
    // RLS R3b: actor resolution is a user-scoped membership read that PRECEDES
    // any org scope — the auth middleware runs it on every request to discover
    // WHICH org the user belongs to and at what role, BEFORE an
    // `app.current_org_id` can be established (it is what establishes it). On the
    // runtime `tanren_app` role (NOBYPASSRLS) with an empty GUC, the
    // deny-by-default policies on `org_members` / `project_members` / `projects`
    // return ZERO rows, so the actor would resolve with NO org/project scopes —
    // and every `/orgs/:orgId/*` route's in-memory `actorCanAccessOrg` check
    // would then 403 even a legitimate org admin. So these membership-resolution
    // reads run on the BYPASSRLS `tanren_system` pool via `runWithSystemScope`,
    // each filtered by `user_id` (+ the addressed org/project id) — the same
    // classification as `ensureOrgMembership` / `upsertOrg`. The result is still
    // correctly scoped to the user's OWN memberships; it is not subject to the
    // org-GUC RLS filter that cannot apply pre-scope. IN-ORG handler reads stay
    // under RLS via the per-request `runWithJobOrgId` org scope.
    let resolvedOrgId: string | null = input.orgId ?? null;
    if (resolvedOrgId !== null) {
      const scopedOrgId = resolvedOrgId;
      const orgRole = await runWithSystemScope(this.pool, (client) =>
        client.query<{ role: OrgMemberRole }>("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [
          scopedOrgId,
          input.userId,
        ]),
      );
      if ((orgRole.rowCount ?? 0) === 0) {
        resolvedOrgId = null;
      } else {
        scopes.add("org:member");
        if (firstRow(orgRole.rows).role === "admin") {
          scopes.add("org:admin");
        }
      }
    }
    let resolvedProjectId: string | null = input.projectId ?? null;
    if (resolvedProjectId !== null) {
      const scopedProjectId = resolvedProjectId;
      const projectRole = await runWithSystemScope(this.pool, (client) =>
        client.query<{ role: ProjectMemberRole }>(
          "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
          [scopedProjectId, input.userId],
        ),
      );
      if ((projectRole.rowCount ?? 0) === 0) {
        // Project membership not declared; try org-scoped fallback if project is owned by user's org.
        const orgOwner = await runWithSystemScope(this.pool, (client) =>
          client.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
            scopedProjectId,
          ]),
        );
        const projectOrg = orgOwner.rows[0]?.org_id ?? null;
        if (projectOrg !== null && projectOrg === resolvedOrgId && scopes.has("org:member")) {
          scopes.add("project:member");
          if (scopes.has("org:admin")) {
            scopes.add("project:admin");
          }
        } else {
          resolvedProjectId = null;
        }
      } else {
        scopes.add("project:member");
        if (firstRow(projectRole.rows).role === "admin") {
          scopes.add("project:admin");
        }
      }
    }
    return {
      userId: input.userId,
      orgId: resolvedOrgId,
      projectId: resolvedProjectId,
      scopes: [...scopes],
      source: input.source,
    };
  }
}

export function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Assert that a query that is known to return exactly one row (a `RETURNING *`
 * insert, or a read guarded by a prior `rowCount` check) actually produced one.
 * Centralises the `noUncheckedIndexedAccess` narrowing for `rows[0]`.
 */
function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected at least one row from query");
  }
  return row;
}

interface UserRow {
  id: string;
  provider: User["provider"];
  provider_subject: string;
  login: string | null;
  email: string | null;
  display_name: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface OrgRow {
  id: string;
  kind: Org["kind"];
  external_id: string;
  login: string;
  display_name: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  expires_at: string | Date;
  created_at: string | Date;
  ip: string | null;
  user_agent: string | null;
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scopes: string[];
  expires_at: string | Date | null;
  last_used_at: string | Date | null;
  created_at: string | Date;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    provider: row.provider,
    providerSubject: row.provider_subject,
    login: row.login,
    email: row.email,
    displayName: row.display_name,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToOrg(row: OrgRow): Org {
  return {
    id: row.id,
    kind: row.kind,
    externalId: row.external_id,
    login: row.login,
    displayName: row.display_name,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    csrfToken: row.csrf_token,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    ip: row.ip,
    userAgent: row.user_agent,
  };
}
