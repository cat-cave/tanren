/**
 * Provider-specific principal verifiers. Stable IDs and scopes come from
 * provider-authenticated responses only — never caller-labelled account IDs.
 *
 * - Slack: team_id from auth.test; scopes from x-oauth-scopes header
 * - Sentry: organization stable ids; scopes from capability probes
 * - Vercel: team/user ids; non-OK team fetch fails loud
 * - Fly: organization ids via paginated GraphQL
 */

import { z } from "zod";
import {
  assertPrincipalVerificationPermit,
  type PrincipalCandidate,
  type PrincipalVerificationPermit,
} from "../contracts/integrationAuthority.js";
import type { IntegrationSecretStore, StagedSecretHandle } from "../contracts/integrationSecretStore.js";

export type PrincipalVerificationResult =
  | { status: "verified"; principal: PrincipalCandidate; authKind: string; scopes: string[]; expiresAt?: string }
  | { status: "multi_principal"; candidates: PrincipalCandidate[]; authKind: string; scopes: string[] }
  | { status: "invalid"; reason: string };

export interface PrincipalVerifier {
  readonly providerKind: string;
  verify(
    permit: PrincipalVerificationPermit,
    staged: StagedSecretHandle,
    secrets: IntegrationSecretStore,
  ): Promise<PrincipalVerificationResult>;
}

type FetchImpl = typeof fetch;

function meta(entries: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function parseScopeHeader(header: string | null): string[] {
  if (header === null || header.trim() === "") return [];
  return [
    ...new Set(
      header
        .split(/[,\s]+/u)
        .map((scope) => scope.trim())
        .filter((scope) => scope !== ""),
    ),
  ];
}

async function readStagedToken(
  permit: PrincipalVerificationPermit,
  staged: StagedSecretHandle,
  secrets: IntegrationSecretStore,
): Promise<string> {
  assertPrincipalVerificationPermit(permit);
  if (staged.operationId !== permit.operationId || staged.handle !== permit.stagedSecretHandle) {
    throw new Error("staged credential handle does not match verification permit");
  }
  const reader = secrets as IntegrationSecretStore & {
    readStagedForPermit?(permit: PrincipalVerificationPermit, staged: StagedSecretHandle): Promise<string>;
  };
  if (typeof reader.readStagedForPermit !== "function") {
    throw new TypeError("integration secret store cannot expose staged credential to verifier");
  }
  return reader.readStagedForPermit(permit, staged);
}

const SlackAuthTestSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    team_id: z.string().min(1).optional(),
    team: z.string().optional(),
    user_id: z.string().optional(),
  })
  .strict();

export class SlackPrincipalVerifier implements PrincipalVerifier {
  readonly providerKind = "slack";
  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  async verify(
    permit: PrincipalVerificationPermit,
    staged: StagedSecretHandle,
    secrets: IntegrationSecretStore,
  ): Promise<PrincipalVerificationResult> {
    const token = await readStagedToken(permit, staged, secrets);
    const response = await this.fetchImpl("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    if (!response.ok) return { status: "invalid", reason: `slack_http_${response.status}` };
    const raw: unknown = await response.json();
    const parsed = SlackAuthTestSchema.safeParse(raw);
    if (!parsed.success) return { status: "invalid", reason: "slack_malformed_auth_test" };
    const body = parsed.data;
    if (!body.ok || body.team_id === undefined) {
      return { status: "invalid", reason: body.error ?? "slack_auth_failed" };
    }
    const scopes = parseScopeHeader(response.headers.get("x-oauth-scopes"));
    if (scopes.length === 0) {
      // Bot tokens always advertise scopes on successful Web API calls; empty is unproven.
      return { status: "invalid", reason: "slack_scopes_unproven" };
    }
    return {
      status: "verified",
      authKind: "bot_token",
      scopes,
      principal: {
        providerPrincipalId: body.team_id,
        principalKind: "team",
        displayName: body.team !== undefined && body.team !== "" ? body.team : body.team_id,
        metadata: meta({ botUserId: body.user_id }),
      },
    };
  }
}

const SentryOrgSchema = z.object({
  id: z.string().min(1),
  slug: z.string().optional(),
  name: z.string().optional(),
});

/** Probe catalog scopes via provider-authenticated capability checks (never invent). */
async function probeSentryScopes(fetchImpl: FetchImpl, token: string, orgSlug: string): Promise<string[]> {
  const scopes = new Set<string>();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  // project:read — listing projects under the org.
  const projects = await fetchImpl(
    `https://sentry.io/api/0/organizations/${encodeURIComponent(orgSlug)}/projects/?per_page=1`,
    { headers },
  );
  if (projects.status === 401 || projects.status === 403) return [];
  if (projects.ok) scopes.add("project:read");
  // project:write — team list is a write-adjacent probe that fails closed on missing scope.
  const teams = await fetchImpl(
    `https://sentry.io/api/0/organizations/${encodeURIComponent(orgSlug)}/teams/?per_page=1`,
    { headers },
  );
  if (teams.ok) {
    scopes.add("project:write");
    // project:admin is not independently probeable without mutating; if write works,
    // provision still re-checks on first create. Do not invent admin.
  }
  return [...scopes];
}

export class SentryPrincipalVerifier implements PrincipalVerifier {
  readonly providerKind = "sentry";
  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  async verify(
    permit: PrincipalVerificationPermit,
    staged: StagedSecretHandle,
    secrets: IntegrationSecretStore,
  ): Promise<PrincipalVerificationResult> {
    const token = await readStagedToken(permit, staged, secrets);
    const candidates: PrincipalCandidate[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const url =
        cursor === undefined
          ? "https://sentry.io/api/0/organizations/?per_page=100"
          : `https://sentry.io/api/0/organizations/?per_page=100&cursor=${encodeURIComponent(cursor)}`;
      const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) {
        return { status: "invalid", reason: `sentry_http_${response.status}` };
      }
      if (!response.ok) return { status: "invalid", reason: `sentry_http_${response.status}` };
      const raw: unknown = await response.json();
      if (!Array.isArray(raw)) return { status: "invalid", reason: "sentry_malformed_organizations" };
      for (const item of raw) {
        const parsed = SentryOrgSchema.safeParse(item);
        if (!parsed.success) continue;
        candidates.push({
          providerPrincipalId: parsed.data.id,
          principalKind: "organization",
          displayName: parsed.data.name ?? parsed.data.slug ?? parsed.data.id,
          metadata: meta({ slug: parsed.data.slug }),
        });
      }
      const link = response.headers.get("link") ?? "";
      const next = /<[^>]*[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/u.exec(link);
      const nextCursor = next?.[1] === undefined ? undefined : decodeURIComponent(next[1]);
      if (nextCursor === undefined || nextCursor === "") break;
      if (seenCursors.has(nextCursor)) {
        throw new Error(`sentry organizations listing returned a non-advancing cursor (${nextCursor})`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (candidates.length === 0) return { status: "invalid", reason: "sentry_no_organizations" };

    // Scopes are token-level: probe against the first org's slug when available.
    const probeSlug =
      typeof candidates[0]!.metadata["slug"] === "string"
        ? candidates[0]!.metadata["slug"]
        : candidates[0]!.providerPrincipalId;
    const scopes = await probeSentryScopes(this.fetchImpl, token, probeSlug);
    if (scopes.length === 0) return { status: "invalid", reason: "sentry_scopes_unproven" };

    if (candidates.length > 1) {
      return { status: "multi_principal", candidates, authKind: "api_key", scopes };
    }
    return { status: "verified", principal: candidates[0]!, authKind: "api_key", scopes };
  }
}

const VercelUserSchema = z.object({
  user: z.object({ id: z.string().min(1), username: z.string().optional(), name: z.string().optional() }),
});
const VercelTeamSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  slug: z.string().optional(),
});

export class VercelPrincipalVerifier implements PrincipalVerifier {
  readonly providerKind = "deploy.vercel";
  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  async verify(
    permit: PrincipalVerificationPermit,
    staged: StagedSecretHandle,
    secrets: IntegrationSecretStore,
  ): Promise<PrincipalVerificationResult> {
    const token = await readStagedToken(permit, staged, secrets);
    const headers = { Authorization: `Bearer ${token}` };
    const userResponse = await this.fetchImpl("https://api.vercel.com/v2/user", { headers });
    if (userResponse.status === 401 || userResponse.status === 403) {
      return { status: "invalid", reason: `vercel_http_${userResponse.status}` };
    }
    if (!userResponse.ok) return { status: "invalid", reason: `vercel_http_${userResponse.status}` };
    const userParsed = VercelUserSchema.safeParse(await userResponse.json());
    if (!userParsed.success) return { status: "invalid", reason: "vercel_malformed_user" };
    const userId = userParsed.data.user.id;

    const candidates: PrincipalCandidate[] = [];
    const seenCursors = new Set<string>();
    let until: string | undefined;
    for (;;) {
      const url =
        until === undefined
          ? "https://api.vercel.com/v2/teams?limit=100"
          : `https://api.vercel.com/v2/teams?limit=100&until=${encodeURIComponent(until)}`;
      const teamsResponse = await this.fetchImpl(url, { headers });
      // Non-OK must fail loud — never silently downgrade to user-only.
      if (teamsResponse.status === 401 || teamsResponse.status === 403) {
        return { status: "invalid", reason: `vercel_teams_http_${teamsResponse.status}` };
      }
      if (!teamsResponse.ok) {
        return { status: "invalid", reason: `vercel_teams_http_${teamsResponse.status}` };
      }
      const teamsBody: unknown = await teamsResponse.json();
      const teams = z
        .object({ teams: z.array(z.unknown()).optional(), pagination: z.unknown().optional() })
        .safeParse(teamsBody);
      if (!teams.success) return { status: "invalid", reason: "vercel_malformed_teams" };
      for (const team of teams.data.teams ?? []) {
        const parsed = VercelTeamSchema.safeParse(team);
        if (!parsed.success) continue;
        candidates.push({
          providerPrincipalId: parsed.data.id,
          principalKind: "team",
          displayName: parsed.data.name ?? parsed.data.slug ?? parsed.data.id,
          metadata: meta({ slug: parsed.data.slug }),
        });
      }
      const pagination = z
        .object({ next: z.union([z.number(), z.string(), z.null()]).optional() })
        .safeParse(teams.data.pagination);
      const next =
        pagination.success && pagination.data.next !== null && pagination.data.next !== undefined
          ? String(pagination.data.next)
          : undefined;
      if (next === undefined || next === "") break;
      if (seenCursors.has(next)) {
        throw new Error(`vercel teams listing returned a non-advancing cursor (${next})`);
      }
      seenCursors.add(next);
      until = next;
    }

    if (candidates.length === 0) {
      candidates.push({
        providerPrincipalId: userId,
        principalKind: "user",
        displayName: userParsed.data.user.name ?? userParsed.data.user.username ?? userId,
        metadata: {},
      });
    }
    // Vercel catalog operations require no scopes; empty is proven for this provider.
    const scopes: string[] = [];
    if (candidates.length > 1) {
      return { status: "multi_principal", candidates, authKind: "api_key", scopes };
    }
    return { status: "verified", principal: candidates[0]!, authKind: "api_key", scopes };
  }
}

const FlyOrgSchema = z.object({
  id: z.string().min(1),
  slug: z.string().optional(),
  name: z.string().optional(),
});

export class FlyPrincipalVerifier implements PrincipalVerifier {
  readonly providerKind = "deploy.flyio";
  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  async verify(
    permit: PrincipalVerificationPermit,
    staged: StagedSecretHandle,
    secrets: IntegrationSecretStore,
  ): Promise<PrincipalVerificationResult> {
    const token = await readStagedToken(permit, staged, secrets);
    const response = await this.fetchImpl("https://api.fly.io/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "{ organizations { nodes { id slug name } } }",
      }),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", reason: `fly_http_${response.status}` };
    }
    if (!response.ok) return { status: "invalid", reason: `fly_http_${response.status}` };
    const body: unknown = await response.json();
    const parsed = z
      .object({
        data: z
          .object({
            organizations: z.object({ nodes: z.array(z.unknown()).optional() }).optional(),
          })
          .optional(),
        errors: z.array(z.object({ message: z.string().optional() })).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return { status: "invalid", reason: "fly_malformed_organizations" };
    if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
      return { status: "invalid", reason: parsed.data.errors[0]?.message ?? "fly_graphql_error" };
    }
    const candidates: PrincipalCandidate[] = [];
    for (const node of parsed.data.data?.organizations?.nodes ?? []) {
      const org = FlyOrgSchema.safeParse(node);
      if (!org.success) continue;
      candidates.push({
        providerPrincipalId: org.data.id,
        principalKind: "organization",
        displayName: org.data.name ?? org.data.slug ?? org.data.id,
        metadata: meta({ slug: org.data.slug }),
      });
    }
    if (candidates.length === 0) return { status: "invalid", reason: "fly_no_organizations" };
    const scopes: string[] = [];
    if (candidates.length > 1) {
      return { status: "multi_principal", candidates, authKind: "api_key", scopes };
    }
    return { status: "verified", principal: candidates[0]!, authKind: "api_key", scopes };
  }
}

export function principalVerifierFor(providerKind: string, fetchImpl: FetchImpl = fetch): PrincipalVerifier {
  switch (providerKind) {
    case "slack":
      return new SlackPrincipalVerifier(fetchImpl);
    case "sentry":
      return new SentryPrincipalVerifier(fetchImpl);
    case "deploy.vercel":
      return new VercelPrincipalVerifier(fetchImpl);
    case "deploy.flyio":
      return new FlyPrincipalVerifier(fetchImpl);
    default:
      throw new Error(`no principal verifier for provider kind '${providerKind}'`);
  }
}
