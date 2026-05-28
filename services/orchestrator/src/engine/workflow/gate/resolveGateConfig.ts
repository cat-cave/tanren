// P3-0005: reads the target repo's `tanren-ci.yml` off the bootstrapped runner
// workspace and resolves it into a typed CI config via the P3-0004 resolver.
// The config lives at the repo root (per the operator guide); when the file is
// absent we hand `undefined` to resolveCiConfig, which yields the documented
// default tiers — never a silent empty gate. Invalid YAML/shape throws from the
// resolver, failing the run loudly rather than gating against nothing.
import { type CiConfigV1, resolveCiConfig } from "../../ci/index.js";
import type { SshTarget } from "../../contracts/allocator.js";
import type { SshSubstrate } from "../../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../../ssh/command.js";

// The repo-root path of the CI contract, relative to the workspace.
const CI_CONFIG_FILENAME = "tanren-ci.yml";

export interface ResolveGateConfigInput {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  timeoutMs: number;
}

// Reads `<workspace>/tanren-ci.yml` over SSH and resolves it. A missing file
// (the `cat` exits nonzero / reports no-such-file) resolves to the default
// config. Any other read failure also degrades to the default so a transient
// stat hiccup never crashes the loop — the resolver still validates content
// when a file IS present.
export async function resolveGateConfig(input: ResolveGateConfigInput): Promise<CiConfigV1> {
  const path = `${input.workspacePath.replace(/\/+$/, "")}/${CI_CONFIG_FILENAME}`;
  const result = await input.ssh.run(input.target, {
    // Print the file when it exists; emit nothing and exit 0 when it does not,
    // so we can distinguish "no config" (→ default) from real content without
    // treating an absent file as an error.
    command: `if [ -f ${quoteSshShellArg(path)} ]; then cat ${quoteSshShellArg(path)}; fi`,
    timeoutMs: input.timeoutMs
  });
  if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
    return resolveCiConfig(undefined);
  }
  const text = result.stdout.trim();
  return resolveCiConfig(text === "" ? undefined : result.stdout);
}
