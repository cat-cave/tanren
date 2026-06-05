// The one concrete {@link CredentialMaterializer} today: it dispatches on `cli`
// to the per-CLI auth materializers (codex / claude / opencode) and normalizes
// each one's CLI-specific result into the seam's flat, redacted env map. This is
// the single place that knows the mapping from a CLI to its config-home env vars,
// so a provider adapter just asks the seam to materialize and exports `env`.
import type {
  CredentialMaterializer,
  MaterializeCredentialInput,
  MaterializedCredential,
} from "../contracts/credentialMaterializer.js";
import { materializeCodexAuthBundle } from "./codexMaterializer.js";
import { materializeClaudeAuthBundle } from "./claudeMaterializer.js";
import { materializeOpencodeAuthBundle } from "./opencodeMaterializer.js";

export class PerCliCredentialMaterializer implements CredentialMaterializer {
  async materialize(input: MaterializeCredentialInput): Promise<MaterializedCredential> {
    switch (input.cli) {
      case "codex": {
        const auth = await materializeCodexAuthBundle(input);
        return {
          cli: "codex",
          env: { CODEX_HOME: auth.CODEX_HOME },
          ref: auth.ref,
          managed: auth.managed,
          redacted: true,
        };
      }
      case "claude": {
        const auth = await materializeClaudeAuthBundle(input);
        return {
          cli: "claude",
          env: { CLAUDE_CONFIG_DIR: auth.CLAUDE_CONFIG_DIR },
          ref: auth.ref,
          managed: auth.managed,
          anthropicBaseUrl: auth.anthropicBaseUrl,
          redacted: true,
        };
      }
      case "opencode": {
        const auth = await materializeOpencodeAuthBundle(input);
        const env: Record<string, string> = { XDG_DATA_HOME: auth.XDG_DATA_HOME };
        if (auth.XDG_CONFIG_HOME !== undefined) {
          env["XDG_CONFIG_HOME"] = auth.XDG_CONFIG_HOME;
        }
        return { cli: "opencode", env, ref: auth.ref, managed: auth.managed, redacted: true };
      }
    }
  }
}
