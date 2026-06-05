// credential reference CRUD. Values live in Vault (or the in-memory
// SecretStore in tests); the routes only manipulate references and never
// return secret values. Credential refs are namespaced as
// `credential/<slug>/<scope>/<ownerId>/<name>`. Org-scoped credentials live
// under `credential/<slug>/org/<orgId>/...`; personal credentials live under
// `credential/<slug>/me/<userId>/...`.
//
// SaaS Tier-A #3: the Vault ref is DERIVED server-side from the authenticated
// `{kind, scope, ownerId}` plus a caller-supplied name (see
// `engine/credentials/refNamespace.ts`); the route never trusts an arbitrary
// caller ref. A caller-supplied full ref is accepted only when byte-equal to
// the server-side derivation for the SAME tenant the route already authorized —
// a ref whose scope/owner segment points at a different tenant is rejected with
// a 400, closing the cross-tenant key-collision/overwrite hole.

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
import { deriveImportRef } from "../../engine/credentials/refNamespace.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

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

// The credential LIST surface (`GET /orgs/:orgId/credentials`, `GET
// /credentials/me`) reads this registry, NOT the secret value — credential
// VALUES live in the SecretStore under `credential/...` and are never listed.
// The registry tracks the {ref, kind, scope, owner, createdAt} METADATA an
// import records, and is itself DURABLE: each record is persisted as a JSON
// value in the SAME SecretStore under a parallel `credregistry/...` namespace,
// so the list survives an orchestrator restart (recovered via
// `SecretStore.list(prefix)`). The org-scoped import routes
// (`POST /orgs/:orgId/credentials`, `POST /credentials/me`) `put` into it and
// are the ONLY credential import path.
export interface CredentialRegistry {
  list(args: { scope: "org" | "me"; ownerId: string }): Promise<CredentialRecord[]>;
  get(ref: string): Promise<CredentialRecord | undefined>;
  put(record: CredentialRecord): Promise<void>;
  delete(ref: string): Promise<void>;
}

/**
 * The registry-record namespace, parallel to the `credential/...` value
 * namespace. The credential ref is base64url-encoded into a SINGLE safe path
 * segment so the record key round-trips losslessly through every SecretStore
 * backend (the credential ref itself contains `/`, which would otherwise split
 * into sub-trees that don't line up with one record).
 */
const REGISTRY_PREFIX = "credregistry/";

function registryRef(credentialRef: string): string {
  return `${REGISTRY_PREFIX}${Buffer.from(credentialRef, "utf8").toString("base64url")}`;
}

/**
 * Durable, SecretStore-backed credential registry. Stores each
 * {@link CredentialRecord} as a JSON value under `credregistry/<b64url(ref)>` in
 * the SAME SecretStore that holds credential values, so the credential LIST
 * survives a process restart. `list` enumerates the namespace via
 * `SecretStore.list` and filters by scope/owner; `get` is a direct keyed read;
 * its signature is unchanged (`get(ref): Promise<CredentialRecord | undefined>`)
 * — the real-writer consumes it.
 */
export class SecretStoreCredentialRegistry implements CredentialRegistry {
  constructor(private readonly secrets: SecretStore) {}

  async list(args: { scope: "org" | "me"; ownerId: string }): Promise<CredentialRecord[]> {
    const refs = await this.secrets.list(REGISTRY_PREFIX);
    const records = await Promise.all(refs.map((ref) => this.readRecord(ref)));
    return records.filter(
      (record): record is CredentialRecord =>
        record !== undefined && record.scope === args.scope && record.ownerId === args.ownerId,
    );
  }

  async get(ref: string): Promise<CredentialRecord | undefined> {
    return this.readRecord(registryRef(ref));
  }

  async put(record: CredentialRecord): Promise<void> {
    await this.secrets.put({ ref: registryRef(record.ref), value: JSON.stringify(record) });
  }

  async delete(ref: string): Promise<void> {
    await this.secrets.delete(registryRef(ref));
  }

  private async readRecord(storeRef: string): Promise<CredentialRecord | undefined> {
    const stored = await this.secrets.get(storeRef);
    return stored === undefined ? undefined : (JSON.parse(stored.value) as CredentialRecord);
  }
}

// Codex, Claude, and opencode all import a JSON auth bundle under {ref, authJson};
// the bundle's own validator (in the credentials module) enforces its shape.
const AuthBundleImportBody = z.object({
  ref: z.string().min(1),
  authJson: z.string().min(1),
});

const GithubImportBody = z.object({
  ref: z.string().min(1),
  token: z.string().min(1),
});

const GithubAppImportBody = z.object({
  ref: z.string().min(1),
  appId: z.string().min(1),
  privateKeyPem: z.string().min(1),
});

const OpaqueImportBody = z.object({
  ref: z.string().min(1),
  value: z.string().min(1),
});

export function createCredentialRoutes(options: CredentialRoutesOptions) {
  const registry = options.registry ?? new SecretStoreCredentialRegistry(options.secrets);
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

  // These org-scoped (`/orgs/:orgId/credentials`) and personal
  // (`/credentials/me`) endpoints are the ONLY credential import surface: every
  // import derives a tenant-namespaced ref AND records a durable registry entry,
  // so an imported credential always appears in the list. There is no
  // unscoped/legacy top-level import path.

  return app;
}

async function handleImport(
  c: {
    req: { json: () => Promise<unknown>; query: (k: string) => string | undefined };
    json: (body: unknown, status?: 200 | 201 | 400) => Response;
  },
  options: CredentialRoutesOptions,
  registry: CredentialRegistry,
  scope: "org" | "me",
  ownerId: string,
  kind: string,
): Promise<Response> {
  const raw = await c.req.json().catch(() => {});
  if (kind === "codex_chatgpt_auth") {
    const parsed = AuthBundleImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_codex_credential", issues: parsed.error.issues }, 400);
    }
    let stored;
    try {
      const ref = deriveImportRef({ supplied: parsed.data.ref, kind: "codex_chatgpt_auth", scope, ownerId });
      stored = await storeCodexAuthBundle(options.secrets, { ...parsed.data, ref });
    } catch (error) {
      return c.json(
        {
          error: "invalid_codex_credential",
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
    await registry.put({
      ref: stored.ref,
      kind: "codex_chatgpt_auth",
      scope,
      ownerId,
      createdAt: new Date().toISOString(),
    });
    return c.json(stored, 201);
  }
  if (kind === "claude_cli_auth") {
    const parsed = AuthBundleImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_claude_credential", issues: parsed.error.issues }, 400);
    }
    let stored;
    try {
      const ref = deriveImportRef({ supplied: parsed.data.ref, kind: "claude_cli_auth", scope, ownerId });
      stored = await storeClaudeAuthBundle(options.secrets, { ...parsed.data, ref });
    } catch (error) {
      return c.json(
        {
          error: "invalid_claude_credential",
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
    await registry.put({
      ref: stored.ref,
      kind: "claude_cli_auth",
      scope,
      ownerId,
      createdAt: new Date().toISOString(),
    });
    return c.json(stored, 201);
  }
  if (kind === "opencode_cli_auth") {
    const parsed = AuthBundleImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_opencode_credential", issues: parsed.error.issues }, 400);
    }
    let stored;
    try {
      const ref = deriveImportRef({ supplied: parsed.data.ref, kind: "opencode_cli_auth", scope, ownerId });
      stored = await storeOpencodeAuthBundle(options.secrets, { ...parsed.data, ref });
    } catch (error) {
      return c.json(
        {
          error: "invalid_opencode_credential",
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
    await registry.put({
      ref: stored.ref,
      kind: "opencode_cli_auth",
      scope,
      ownerId,
      createdAt: new Date().toISOString(),
    });
    return c.json(stored, 201);
  }
  if (kind === "github_token") {
    const parsed = GithubImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_github_credential", issues: parsed.error.issues }, 400);
    }
    let stored;
    try {
      const ref = deriveImportRef({ supplied: parsed.data.ref, kind: "github_token", scope, ownerId });
      stored = await storeGithubToken(options.secrets, { ...parsed.data, ref });
    } catch (error) {
      return c.json(
        {
          error: "invalid_github_credential",
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
    await registry.put({
      ref: stored.ref,
      kind: "github_token",
      scope,
      ownerId,
      createdAt: new Date().toISOString(),
    });
    return c.json(stored, 201);
  }
  if (kind === "github_app") {
    const parsed = GithubAppImportBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_github_app_credential", issues: parsed.error.issues }, 400);
    }
    let stored;
    try {
      const ref = deriveImportRef({ supplied: parsed.data.ref, kind: "github_app", scope, ownerId });
      stored = await storeGithubAppCredential(options.secrets, { ...parsed.data, ref });
    } catch (error) {
      return c.json(
        {
          error: "invalid_github_app_credential",
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
    await registry.put({
      ref: stored.ref,
      kind: "github_app",
      scope,
      ownerId,
      createdAt: new Date().toISOString(),
    });
    return c.json(stored, 201);
  }
  const parsed = OpaqueImportBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_credential", issues: parsed.error.issues }, 400);
  }
  let ref: string;
  try {
    ref = deriveImportRef({ supplied: parsed.data.ref, kind: "opaque", scope, ownerId });
  } catch (error) {
    return c.json(
      {
        error: "invalid_credential",
        message: error instanceof Error ? error.message : String(error),
      },
      400,
    );
  }
  await options.secrets.put({ ref, value: parsed.data.value });
  await registry.put({
    ref,
    kind: "opaque",
    scope,
    ownerId,
    createdAt: new Date().toISOString(),
  });
  return c.json({ ref, kind: "opaque", redacted: true }, 201);
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
