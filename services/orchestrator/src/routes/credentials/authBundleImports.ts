import type { Env, Hono } from "hono";
import { z } from "zod";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { storeClaudeAuthBundle } from "../../engine/credentials/claudeAuth.js";
import { storeCodexAuthBundle } from "../../engine/credentials/codexAuth.js";
import { storeOpencodeAuthBundle } from "../../engine/credentials/opencodeAuth.js";

// P3-0012: the legacy top-level `/credentials/<slug>/import` routes. Codex
// (Phase 1) plus Claude + opencode all import a {ref, authJson} auth bundle;
// each provider's own validator enforces its bundle shape. They share one
// handler so adding a provider is one table row, not a new route — and adds no
// schema migration (the credential is a Vault-backed secret, not a DB column).

const authBundleImportSchema = z.object({
  ref: z.string().min(1),
  authJson: z.string().min(1),
});

const authBundleImporters: ReadonlyArray<{
  slug: string;
  error: string;
  store: (secrets: SecretStore, input: { ref: string; authJson: string }) => Promise<unknown>;
}> = [
  { slug: "codex", error: "invalid_codex_credential", store: storeCodexAuthBundle },
  { slug: "claude", error: "invalid_claude_credential", store: storeClaudeAuthBundle },
  { slug: "opencode", error: "invalid_opencode_credential", store: storeOpencodeAuthBundle },
];

export function registerAuthBundleImportRoutes<E extends Env>(app: Hono<E>, secrets: SecretStore): void {
  for (const provider of authBundleImporters) {
    app.post(`/credentials/${provider.slug}/import`, async (c) => {
      const parsed = authBundleImportSchema.safeParse(await c.req.json().catch(() => {}));
      if (!parsed.success) {
        return c.json({ error: provider.error, issues: parsed.error.issues }, 400);
      }
      try {
        return c.json(await provider.store(secrets, parsed.data), 201);
      } catch (error) {
        return c.json(
          {
            error: provider.error,
            message: error instanceof Error ? error.message : String(error),
          },
          400,
        );
      }
    });
  }
}
