// P3-0005: reads the target repo's `tanren-ci.yml` off the bootstrapped runner
// workspace and resolves it into a typed CI config via the P3-0004 resolver.
// The config lives at the repo root (per the operator guide); when the file is
// absent we hand `undefined` to resolveCiConfig, which yields the documented
// default tiers — never a silent empty gate. Invalid YAML/shape throws from the
// resolver, failing the run loudly rather than gating against nothing.
import { bootstrapCommand, type CiConfigV1, resolveCiConfig } from "../../ci/index.js";
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

// Reads `<workspace>/tanren-ci.yml` over SSH. Returns the raw file text when the
// file is present and non-empty, or `undefined` when it is absent or unreadable.
// The `cat`-if-present command emits nothing and exits 0 when the file does not
// exist, so we distinguish "no config" (→ undefined) from real content without
// treating an absent file as an error. Any read failure (substrate error,
// timeout, nonzero exit) also yields `undefined` so a transient stat hiccup
// degrades to the default rather than crashing the loop.
async function readCiConfigText(input: ResolveGateConfigInput): Promise<string | undefined> {
  const path = `${input.workspacePath.replace(/\/+$/u, "")}/${CI_CONFIG_FILENAME}`;
  const result = await input.ssh.run(input.target, {
    command: `if [ -f ${quoteSshShellArg(path)} ]; then cat ${quoteSshShellArg(path)}; fi`,
    timeoutMs: input.timeoutMs,
  });
  if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.trim() === "" ? undefined : result.stdout;
}

// Reads `<workspace>/tanren-ci.yml` over SSH and resolves it. A missing file
// resolves to the default config — never a silent empty gate. Invalid YAML/shape
// throws from the resolver, failing the run loudly rather than gating against
// nothing.
export async function resolveGateConfig(input: ResolveGateConfigInput): Promise<CiConfigV1> {
  return resolveCiConfig(await readCiConfigText(input));
}

// Resolves the install command for the workspace-bootstrap step from the repo's
// `tanren-ci.yml` `bootstrap.run`. Returns `undefined` when the repo declares no
// config file, so the caller's DEFAULT install command applies (the cold bootstrap
// uses its pnpm/npm-detecting DEFAULT_BOOTSTRAP_COMMAND heuristic; the in-loop
// deps-ensure picks greenfield-non-frozen vs brownfield-frozen) — we only override
// that default when the repo actually ships a tanren-ci.yml WITH a `bootstrap.run`.
// A present-but-invalid config still throws from resolveCiConfig, surfacing a
// misconfigured repo loudly. NOTE: `bootstrap.run` is OPTIONAL with no schema
// default, so a config that omits `bootstrap` (or `bootstrap.run`) yields
// `undefined` here too — the caller's default applies, NOT a baked-in command.
export async function resolveBootstrapCommand(input: ResolveGateConfigInput): Promise<string | undefined> {
  const text = await readCiConfigText(input);
  if (text === undefined) {
    return undefined;
  }
  return bootstrapCommand(resolveCiConfig(text));
}
