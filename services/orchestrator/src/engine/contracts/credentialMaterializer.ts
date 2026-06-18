// The CREDENTIAL MATERIALIZER seam — one named contract over the per-CLI auth
// materializers. Before a run's writer/answerer can call a coding CLI, that CLI's
// credentials must be written into a per-run config home on the runner (Codex's
// CODEX_HOME/auth.json, Claude's CLAUDE_CONFIG_DIR/.credentials.json, opencode's
// XDG data-home/auth.json — or, in MANAGED mode, the OpenRouter config files).
// That behavior already exists as three free functions
// (engine/credentials/{codex,claude,opencode}Materializer.ts); this contract
// gives them ONE interface so a provider adapter asks "materialize <cli>'s
// credential" without knowing which CLI's file layout applies.
//
// The secret bytes always ride a FileSubstrate write (stdin/heredoc) — never a
// command string or an event — and the result is REDACTED: it carries the per-run
// config-home env var + the validated ref, never the credential value.
import type { RunnerHandle } from "./allocator.js";
import type { CommandSubstrate } from "./commandSubstrate.js";
import type { SecretStore } from "./secretStore.js";

// The coding CLIs whose credentials this seam materializes.
export type MaterializerCli = "codex" | "claude" | "opencode";

// What a materialization needs: the secret store to read the credential from, the
// command substrate to reach the runner, the runner handle, the credential ref,
// and the run id (scopes the per-run config-home path). `managed` + `endpointBaseUrl`
// select the OpenRouter cookbook path; absent ⇒ BYOK.
export interface MaterializeCredentialInput {
  cli: MaterializerCli;
  secrets: SecretStore;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  ref: string;
  runId: string;
  baseDir?: string;
  managed?: boolean;
  endpointBaseUrl?: string;
}

// The redacted outcome: the per-run config-home env vars the writer must export
// (CLI-specific keys — CODEX_HOME / CLAUDE_CONFIG_DIR / XDG_DATA_HOME / …), the
// validated ref, and the managed flag. NEVER the secret value. `env` is the flat
// map of env-var name → value the command builder sources; `ref`/`managed` mirror
// the per-CLI result for callers that branch on them.
export interface MaterializedCredential {
  cli: MaterializerCli;
  env: Record<string, string>;
  ref: string;
  managed: boolean;
  // The Anthropic-compatible base URL (Claude managed) / undefined otherwise —
  // surfaced so the command builder can export ANTHROPIC_BASE_URL without the
  // caller re-deriving it. Other CLIs leave it undefined.
  anthropicBaseUrl?: string;
  redacted: true;
}

// THE seam. One materializer materializes any supported CLI's credential.
export interface CredentialMaterializer {
  materialize(input: MaterializeCredentialInput): Promise<MaterializedCredential>;
}
