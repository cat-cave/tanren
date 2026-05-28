// P2A-0013: credential reference CRUD. Values live in Vault (or the in-memory
// SecretStore in tests); the routes only manipulate references and never
// return secret values. Credential refs are namespaced as
// `credential/<kind>/<scope>/<name>`. Org-scoped credentials live under
// `credential/<kind>/org/<orgId>/...`; personal credentials live under
// `credential/<kind>/me/<userId>/...`.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { storeClaudeAuthBundle } from "../../engine/credentials/claudeAuth.js";
import { storeCodexAuthBundle } from "../../engine/credentials/codexAuth.js";
import { storeGithubAppCredential } from "../../engine/credentials/githubApp.js";
import { storeGithubToken } from "../../engine/credentials/githubToken.js";
import { storeOpencodeAuthBundle } from "../../engine/credentials/opencodeAuth.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface CredentialRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  /** Registry of refs the orchestrator has been told about, indexed by scope. */
  registry?: CredentialRegistry;
}

export interface CredentialRecord {
  ref: string;
  kind: "codex_chatgpt_auth" | "claude_cli_auth" | "opencode_cli_auth" | "github_token" | "github_app" | "opaque";
  scope: "org" | "me";
  ownerId: string;
  createdAt: string;
}

export interface CredentialRegistry {
  list(args: { scope: "org" | "me"; ownerId: string }): Promise<CredentialRecord[]>;
  get(ref: string): Promise<CredentialRecord | undefined>;
  put(record: CredentialRecord): Promise<void>;
  delete(ref: string): Promise<void>;
}

export class InMemoryCredentialRegistry implements CredentialRegistry {
  private readonly records = new Map<string, CredentialRecord>();

  async list(args: { scope: "org" | "me"; ownerId: string }): Promise<CredentialRecord[]> {
    return [...this.records.values()].filter(
      (record) => record.scope === args.scope && record.ownerId === args.ownerId
    );
  }

  async get(ref: string): Promise<CredentialRecord | undefined> {
    return this.records.get(ref);
  }

  async put(record: CredentialRecord): Promise<void> {
    this.records.set(record.ref, record);
  }

  async delete(ref: string): Promise<void> {
    this.records.delete(ref);
  }
}

// Codex, Claude, and opencode all import a JSON auth bundle under {ref, authJson};
// the bundle's own validator (in the credentials module) enforces its shape.
const AuthBundleImportBody = z.object({
  ref: z.string().min(1),
  authJson: z.string().min(1)
});

const GithubImportBody = z.object({
  ref: z.string().min(1),
  token: z.string().min(1)
});

const GithubAppImportBody = z.object({
  ref: z.string().min(1),
  appId: z.string().min(1),
  privateKeyPem: z.string().min(1)
});

const OpaqueImportBody = z.object({
  ref: z.string().min(1),
  value: z.string().min(1)
});

export function createCredentialRoutes(options: CredentialRoutesOptions) {
  const registry = options.registry ?? new InMemoryCredentialRegistry();
  const app = new Hono<ActorContextEnv>();

  app.get("/orgs/:orgId/credentials", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const records = await registry.list({ scope: "org", ownerId: orgId });
    return c.json({ credentials: records });
  });

  app.post("/orgs/:orgId/credentials", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const kind = c.req.query("kind") ?? "opaque";
    return await handleImport(c, options, registry, "org", orgId, kind);
  });

  app.get("/orgs/:orgId/credentials/:credentialId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const record = await registry.get(decodeURIComponent(c.req.param("credentialId")));
    if (record === undefined || record.scope !== "org" || record.ownerId !== orgId) {
      return c.json({ error: "credential_not_found" }, 404);
    }
    return c.json(record);
  });

  app.delete("/orgs/:orgId/credentials/:credentialId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const ref = decodeURIComponent(c.req.param("credentialId"));
    const record = await registry.get(ref);
    if (record === undefined || record.scope !== "org" || record.ownerId !== orgId) {
      return c.json({ error: "credential_not_found" }, 404);
    }
    await options.secrets.delete(ref);
    await registry.delete(ref);
    return c.json({ ok: true });
  });

  app.get("/credentials/me", async (c) => {
    const actor = requireActor(c);
    const records = await registry.list({ scope: "me", ownerId: actor.userId });
    return c.json({ credentials: records });
  });

  app.post("/credentials/me", async (c) => {
    const actor = requireActor(c);
    const kind = c.req.query("kind") ?? "opaque";
    return await handleImport(c, options, registry, "me", actor.userId, kind);
  });

  // The Phase 1 import endpoints `/credentials/codex/import` and
  // `/credentials/github/import` remain mounted directly on the app in
  // `src/main.ts` for backwards compatibility with operators and tests that
  // hit them without going through the org-scoped endpoints. The new
  // `/orgs/:orgId/credentials` and `/credentials/me` endpoints above are the
  // recommended P2A-0013 surface.

  return app;
}

async function handleImport(
  c: { req: { json: () => Promise<unknown>; query: (k: string) => string | undefined }; json: (body: unknown, status?: 200 | 201 | 400) => Response },
  options: CredentialRoutesOptions,
  registry: CredentialRegistry,
  scope: "org" | "me",
  ownerId: string,
  kind: string
): Promise<Response> {
  const raw = await c.req.json().catch(() => undefined);
  if (kind === "codex_chatgpt_auth") {
    const parsed = AuthBundleImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_codex_credential", issues: parsed.error.issues }, 400);
    }
    let stored;
    try {
      stored = await storeCodexAuthBundle(options.secrets, parsed.data);
    } catch (error) {
      return c.json({ error: "invalid_codex_credential", message: error instanceof Error ? error.message : String(error) }, 400);
    }
    await registry.put({ ref: stored.ref, kind: "codex_chatgpt_auth", scope, ownerId, createdAt: new Date().toISOString() });
    return c.json(stored, 201);
  }
  if (kind === "claude_cli_auth") {
    const parsed = AuthBundleImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_claude_credential", issues: parsed.error.issues }, 400);
    }
    let stored;
    try {
      stored = await storeClaudeAuthBundle(options.secrets, parsed.data);
    } catch (error) {
      return c.json({ error: "invalid_claude_credential", message: error instanceof Error ? error.message : String(error) }, 400);
    }
    await registry.put({ ref: stored.ref, kind: "claude_cli_auth", scope, ownerId, createdAt: new Date().toISOString() });
    return c.json(stored, 201);
  }
  if (kind === "opencode_cli_auth") {
    const parsed = AuthBundleImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_opencode_credential", issues: parsed.error.issues }, 400);
    }
    let stored;
    try {
      stored = await storeOpencodeAuthBundle(options.secrets, parsed.data);
    } catch (error) {
      return c.json({ error: "invalid_opencode_credential", message: error instanceof Error ? error.message : String(error) }, 400);
    }
    await registry.put({ ref: stored.ref, kind: "opencode_cli_auth", scope, ownerId, createdAt: new Date().toISOString() });
    return c.json(stored, 201);
  }
  if (kind === "github_token") {
    const parsed = GithubImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_github_credential", issues: parsed.error.issues }, 400);
    }
    const stored = await storeGithubToken(options.secrets, parsed.data);
    await registry.put({ ref: stored.ref, kind: "github_token", scope, ownerId, createdAt: new Date().toISOString() });
    return c.json(stored, 201);
  }
  if (kind === "github_app") {
    const parsed = GithubAppImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_github_app_credential", issues: parsed.error.issues }, 400);
    }
    let stored;
    try {
      stored = await storeGithubAppCredential(options.secrets, parsed.data);
    } catch (error) {
      return c.json({ error: "invalid_github_app_credential", message: error instanceof Error ? error.message : String(error) }, 400);
    }
    await registry.put({ ref: stored.ref, kind: "github_app", scope, ownerId, createdAt: new Date().toISOString() });
    return c.json(stored, 201);
  }
  const parsed = OpaqueImportBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_credential", issues: parsed.error.issues }, 400);
  }
  await options.secrets.put({ ref: parsed.data.ref, value: parsed.data.value });
  await registry.put({ ref: parsed.data.ref, kind: "opaque", scope, ownerId, createdAt: new Date().toISOString() });
  return c.json({ ref: parsed.data.ref, kind: "opaque", redacted: true }, 201);
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
