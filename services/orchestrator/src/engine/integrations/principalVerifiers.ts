/**
 * Provider-specific principal verifiers. Stable IDs come from provider APIs only —
 * never from caller-labelled account IDs.
 *
 * - Slack: team_id from auth.test
 * - Sentry: organization stable id from /api/0/organizations/
 * - Vercel: team id(s) and/or user id from /v2/user + /v2/teams
 * - Fly: organization id from GraphQL organizations query
 */

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

async function readStagedToken(
  permit: PrincipalVerificationPermit,
  staged: StagedSecretHandle,
  secrets: IntegrationSecretStore,
): Promise<string> {
  assertPrincipalVerificationPermit(permit);
  if (staged.operationId !== permit.operationId || staged.handle !== permit.stagedSecretHandle) {
    throw new Error("staged credential handle does not match verification permit");
  }
  // Stage lives at handle path; re-read via compensate-safe temporary finalize path
  // is intentionally not used — stage values are only accessible by finalize.
  // IntegrationSecretStore does not expose staged reads; verifiers receive token
  // through a sealed helper on the store implementation.
  const reader = secrets as IntegrationSecretStore & {
    readStagedForPermit?(permit: PrincipalVerificationPermit, staged: StagedSecretHandle): Promise<string>;
  };
  if (typeof reader.readStagedForPermit !== "function") {
    throw new TypeError("integration secret store cannot expose staged credential to verifier");
  }
  return reader.readStagedForPermit(permit, staged);
}

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
    const body = (await response.json()) as {
      ok?: boolean;
      error?: string;
      team_id?: string;
      team?: string;
      user_id?: string;
    };
    if (body.ok !== true || typeof body.team_id !== "string" || body.team_id === "") {
      return { status: "invalid", reason: body.error ?? "slack_auth_failed" };
    }
    return {
      status: "verified",
      authKind: "bot_token",
      scopes: [],
      principal: {
        providerPrincipalId: body.team_id,
        principalKind: "team",
        displayName: typeof body.team === "string" && body.team !== "" ? body.team : body.team_id,
        metadata: meta({ botUserId: typeof body.user_id === "string" ? body.user_id : undefined }),
      },
    };
  }
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
    const response = await this.fetchImpl("https://sentry.io/api/0/organizations/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", reason: `sentry_http_${response.status}` };
    }
    if (!response.ok) return { status: "invalid", reason: `sentry_http_${response.status}` };
    const body = (await response.json()) as Array<{ id?: string; slug?: string; name?: string }>;
    if (!Array.isArray(body) || body.length === 0) {
      return { status: "invalid", reason: "sentry_no_organizations" };
    }
    const candidates: PrincipalCandidate[] = body
      .filter((org) => typeof org.id === "string" && org.id !== "")
      .map((org) => ({
        providerPrincipalId: org.id!,
        principalKind: "organization" as const,
        displayName: org.name ?? org.slug ?? org.id!,
        metadata: meta({ slug: typeof org.slug === "string" ? org.slug : undefined }),
      }));
    if (candidates.length === 0) return { status: "invalid", reason: "sentry_no_organizations" };
    if (candidates.length > 1) {
      return { status: "multi_principal", candidates, authKind: "api_key", scopes: [] };
    }
    return { status: "verified", principal: candidates[0]!, authKind: "api_key", scopes: [] };
  }
}

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
    const userBody = (await userResponse.json()) as { user?: { id?: string; username?: string; name?: string } };
    const userId = userBody.user?.id;
    if (typeof userId !== "string" || userId === "") {
      return { status: "invalid", reason: "vercel_no_user" };
    }
    const teamsResponse = await this.fetchImpl("https://api.vercel.com/v2/teams", { headers });
    const candidates: PrincipalCandidate[] = [];
    if (teamsResponse.ok) {
      const teamsBody = (await teamsResponse.json()) as {
        teams?: Array<{ id?: string; name?: string; slug?: string }>;
      };
      for (const team of teamsBody.teams ?? []) {
        if (typeof team.id === "string" && team.id !== "") {
          candidates.push({
            providerPrincipalId: team.id,
            principalKind: "team",
            displayName: team.name ?? team.slug ?? team.id,
            metadata: meta({ slug: typeof team.slug === "string" ? team.slug : undefined }),
          });
        }
      }
    }
    if (candidates.length === 0) {
      candidates.push({
        providerPrincipalId: userId,
        principalKind: "user",
        displayName: userBody.user?.name ?? userBody.user?.username ?? userId,
        metadata: {},
      });
    }
    if (candidates.length > 1) {
      return { status: "multi_principal", candidates, authKind: "api_key", scopes: [] };
    }
    return { status: "verified", principal: candidates[0]!, authKind: "api_key", scopes: [] };
  }
}

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
    const body = (await response.json()) as {
      data?: { organizations?: { nodes?: Array<{ id?: string; slug?: string; name?: string }> } };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors !== undefined && body.errors.length > 0) {
      return { status: "invalid", reason: body.errors[0]?.message ?? "fly_graphql_error" };
    }
    const nodes = body.data?.organizations?.nodes ?? [];
    const candidates: PrincipalCandidate[] = nodes
      .filter((org) => typeof org.id === "string" && org.id !== "")
      .map((org) => ({
        providerPrincipalId: org.id!,
        principalKind: "organization" as const,
        displayName: org.name ?? org.slug ?? org.id!,
        metadata: meta({ slug: typeof org.slug === "string" ? org.slug : undefined }),
      }));
    if (candidates.length === 0) return { status: "invalid", reason: "fly_no_organizations" };
    if (candidates.length > 1) {
      return { status: "multi_principal", candidates, authKind: "api_key", scopes: [] };
    }
    return { status: "verified", principal: candidates[0]!, authKind: "api_key", scopes: [] };
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
