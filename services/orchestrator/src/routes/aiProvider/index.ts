// Wave-2 operator API: the "Connect AI provider" + billing-mode settings surface.
//
// Mirrors a real "Connect your AI provider" settings screen so the operator API
// is a 1-1 mirror of the product UX — no Vault-seeding, no raw config PATCH, no
// excessive env. Three dedicated, discoverable endpoints (the same dedicated-
// endpoint pattern as routes/projects/budget.ts + the org-budget routes):
//
//   POST /orgs/:orgId/ai-provider  { provider, apiKey? | authJson?, makeDefault? }
//     → connect a BYOK LLM provider. Stores the secret under a COST-CLASSIFIABLE
//       ref (engine/credentials/aiProvider.ts) so `classifyAuthRef` prices it,
//       records it in the credential registry, and (default) wires it as the
//       org's default LLM credential + flips providerMode → "byok" through the
//       SAME org-config path the rest of config uses. Returns
//       { provider, ref, classifiedAs: "<billing_mode>/<provider>", isDefault }
//       so the operator KNOWS the budget gate will meter it. The secret VALUE is
//       never returned or logged.
//
//   GET  /orgs/:orgId/ai-provider
//     → list connected providers (ref + provider + classifiedAs + isDefault),
//       values never exposed.
//
//   PUT  /orgs/:orgId/billing  { mode: "managed" | "byok" }
//     → the managed-vs-BYOK toggle as a clean setting (replaces hand-editing
//       `providerMode` in the config blob). Managed mode resolves the platform
//       credential as today (a hosting concern).
//
// All routes run org-scoped under RLS (the route is mounted on the orchestrator's
// `scopedPool`) and are actor-authorized: reads require org membership, writes
// require org admin.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { migrateOrgConfig, type OrgConfigV1 } from "../../engine/config/orgConfig.js";
import { ProviderMode } from "../../engine/config/managedProvider.js";
import {
  AI_PROVIDERS,
  type AiProvider,
  aiProviderSecretKind,
  classifiedAsLabel,
  deriveAiProviderRef,
} from "../../engine/credentials/aiProvider.js";
import { storeCodexAuthBundle } from "../../engine/credentials/codexAuth.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";
import type { CredentialRecord, CredentialRegistry } from "../credentials/index.js";
import { SecretStoreCredentialRegistry } from "../credentials/index.js";

interface AiProviderRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  /** Shared credential registry (durable list). Defaults to the SecretStore-backed one. */
  registry?: CredentialRegistry;
}

// The connect body. Exactly one of `apiKey` (OpenRouter/Anthropic/OpenAI) or
// `authJson` (the Codex ChatGPT bundle) is required, matching the provider's
// secret kind — enforced in the handler so the error names the expected field.
// `name` is the trailing ref segment (defaults to "default"); `makeDefault`
// defaults to true (connecting a provider wires it for runs unless opted out).
const ConnectBody = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    apiKey: z.string().min(1).optional(),
    authJson: z.string().min(1).optional(),
    name: z.string().min(1).default("default"),
    makeDefault: z.boolean().default(true),
  })
  .strict();

const BillingPutBody = z.object({ mode: ProviderMode }).strict();

/** The connect response — confirms the connected key WILL be cost-metered. */
interface ConnectView {
  provider: AiProvider;
  ref: string;
  classifiedAs: string;
  isDefault: boolean;
}

/** One row of the GET list — values never exposed. */
interface ConnectedProviderView {
  provider: AiProvider;
  ref: string;
  classifiedAs: string;
  isDefault: boolean;
}

export function createAiProviderRoutes(options: AiProviderRoutesOptions) {
  const registry = options.registry ?? new SecretStoreCredentialRegistry(options.secrets);
  const app = new Hono<ActorContextEnv>();

  // POST /orgs/:orgId/ai-provider — connect a BYOK LLM provider.
  app.post("/:orgId/ai-provider", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = ConnectBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_ai_provider", issues: parsed.error.issues }, 400);
    }
    const { provider, name, makeDefault } = parsed.data;

    // Derive the tenant-namespaced, cost-classifiable ref. The slug is keyed off
    // the provider so the prefix matches `classifyAuthRef` — the guarantee that
    // the connected key is metered.
    let ref: string;
    try {
      ref = deriveAiProviderRef({ provider, scope: "org", ownerId: orgId, name });
    } catch (error) {
      return c.json({ error: "invalid_ai_provider", message: messageOf(error) }, 400);
    }

    // Store the secret under that ref. Codex takes the validated ChatGPT bundle
    // (reusing the existing import path); the API-key providers store the raw
    // token as the secret VALUE. Either way the value is never returned/logged.
    const secretKind = aiProviderSecretKind(provider);
    try {
      if (secretKind === "auth_bundle") {
        if (parsed.data.authJson === undefined) {
          return c.json(
            { error: "invalid_ai_provider", message: "codex requires authJson (the ChatGPT auth bundle)" },
            400,
          );
        }
        await storeCodexAuthBundle(options.secrets, { ref, authJson: parsed.data.authJson });
      } else {
        if (parsed.data.apiKey === undefined) {
          return c.json({ error: "invalid_ai_provider", message: `${provider} requires apiKey` }, 400);
        }
        await options.secrets.put({ ref, value: parsed.data.apiKey });
      }
    } catch (error) {
      return c.json({ error: "invalid_ai_provider", message: messageOf(error) }, 400);
    }

    // Record it in the durable registry so it appears in the credential list.
    // The cost classification keys on the ref PREFIX (not this `kind`), so the
    // kind is just metadata: the codex bundle records as `codex_chatgpt_auth`,
    // the API-key providers as `opaque`.
    const recordKind: CredentialRecord["kind"] = secretKind === "auth_bundle" ? "codex_chatgpt_auth" : "opaque";
    await registry.put({ ref, kind: recordKind, scope: "org", ownerId: orgId, createdAt: new Date().toISOString() });

    // Wire it as the org's default LLM credential for runs, through the SAME
    // org-config path the rest of config uses (read-modify-write of
    // `organizations.config`). Setting `defaultCredentials.codex_chatgpt_auth`
    // makes this ref the run's default LLM `authRef` (resolveCredentialsForRun →
    // buildEffectiveRouting fills empty routing chains with it), and flipping
    // `providerMode: "byok"` ensures the tenant credential (not a managed shell)
    // is resolved. `makeDefault: false` connects without changing routing.
    let isDefault = false;
    if (makeDefault) {
      const loaded = await loadOrgConfig(options.pool, orgId);
      if (loaded === undefined) {
        return c.json({ error: "org_not_found" }, 404);
      }
      const nextConfig = migrateOrgConfig({
        ...loaded,
        providerMode: "byok",
        defaultCredentials: { ...loaded.defaultCredentials, codex_chatgpt_auth: ref },
      });
      await writeOrgConfig(options.pool, orgId, nextConfig);
      isDefault = true;
    }

    // `classifiedAsLabel` re-classifies the derived ref (throws if it is not a
    // metered prefix), so the returned label can never disagree with how runs
    // price it.
    const view: ConnectView = { provider, ref, classifiedAs: classifiedAsLabel(ref), isDefault };
    return c.json(view, 201);
  });

  // GET /orgs/:orgId/ai-provider — list connected providers (values never exposed).
  app.get("/:orgId/ai-provider", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const loaded = await loadOrgConfig(options.pool, orgId);
    if (loaded === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    const defaultRef = loaded.defaultCredentials?.codex_chatgpt_auth;
    const records = await registry.list({ scope: "org", ownerId: orgId });
    const providers: ConnectedProviderView[] = [];
    for (const record of records) {
      const provider = providerForRef(record.ref);
      if (provider === undefined) {
        // Not an AI-provider credential (e.g. a github_token) — skip.
        continue;
      }
      providers.push({
        provider,
        ref: record.ref,
        classifiedAs: classifiedAsLabel(record.ref),
        isDefault: record.ref === defaultRef,
      });
    }
    return c.json({ providerMode: loaded.providerMode, providers });
  });

  // PUT /orgs/:orgId/billing — the managed-vs-BYOK toggle as a clean setting.
  app.put("/:orgId/billing", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = BillingPutBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_billing_mode", issues: parsed.error.issues }, 400);
    }
    const loaded = await loadOrgConfig(options.pool, orgId);
    if (loaded === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    const nextConfig = migrateOrgConfig({ ...loaded, providerMode: parsed.data.mode });
    await writeOrgConfig(options.pool, orgId, nextConfig);
    return c.json({ mode: nextConfig.providerMode });
  });

  return app;
}

/** Which connected AI provider a credential ref belongs to, or undefined. */
function providerForRef(ref: string): AiProvider | undefined {
  for (const provider of AI_PROVIDERS) {
    // Re-derive the prefix the same way the connect path does, anchored to the
    // slug — a ref is "this provider's" when it starts with `credential/<slug>/`.
    const prefix = providerRefPrefix(provider);
    if (ref.startsWith(prefix)) {
      return provider;
    }
  }
  return undefined;
}

/** `credential/<slug>/` for a provider — derived once from the shared mapping. */
function providerRefPrefix(provider: AiProvider): string {
  // Probe-derive a ref then slice to its `credential/<slug>/` prefix so this
  // never hard-codes a slug that could drift from `deriveAiProviderRef`.
  const probe = deriveAiProviderRef({ provider, scope: "org", ownerId: "probe", name: "probe" });
  const parts = probe.split("/");
  return `${parts[0]}/${parts[1]}/`;
}

async function loadOrgConfig(pool: pg.Pool, orgId: string): Promise<OrgConfigV1 | undefined> {
  const result = await pool.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [orgId]);
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  return migrateOrgConfig(row.config);
}

async function writeOrgConfig(pool: pg.Pool, orgId: string, config: OrgConfigV1): Promise<void> {
  await pool.query("UPDATE organizations SET config = $1::jsonb, updated_at = now() WHERE id = $2", [
    JSON.stringify(config),
    orgId,
  ]);
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
