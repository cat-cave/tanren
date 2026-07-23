import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export interface CraPaths {
  readonly configFile: string;
  readonly stateRoot: string;
  readonly lockFile: string;
  readonly prsDirectory: string;
  readonly auditsDirectory: string;
  readonly eventsDirectory: string;
  readonly draftsDirectory: string;
}

function xdgRoot(env: NodeJS.ProcessEnv, variable: "XDG_CONFIG_HOME" | "XDG_STATE_HOME", fallback: string): string {
  const configured = env[variable];
  const root = configured ?? resolve(env["HOME"] ?? homedir(), fallback);
  if (!isAbsolute(root)) throw new Error(`${variable} must be an absolute path`);
  return resolve(root);
}

export function repositoryStateSlug(repository: string): string {
  return repository.replaceAll("/", "-").toLowerCase();
}

export function resolveCraPaths(repository: string, env: NodeJS.ProcessEnv = process.env): CraPaths {
  const stateRoot = resolve(
    xdgRoot(env, "XDG_STATE_HOME", ".local/state"),
    "tanren-cra",
    repositoryStateSlug(repository),
  );
  const configFile =
    env["TANREN_CRA_CONFIG"] ?? resolve(xdgRoot(env, "XDG_CONFIG_HOME", ".config"), "tanren-cra", "config.json");
  if (!isAbsolute(configFile)) throw new Error("TANREN_CRA_CONFIG must be an absolute path");
  return {
    configFile: resolve(configFile),
    stateRoot,
    lockFile: resolve(stateRoot, "supervisor.lock"),
    prsDirectory: resolve(stateRoot, "prs"),
    auditsDirectory: resolve(stateRoot, "audits"),
    eventsDirectory: resolve(stateRoot, "events"),
    draftsDirectory: resolve(stateRoot, "drafts"),
  };
}

export function assertOutsideRepository(path: string, repositoryRoot: string, description: string): void {
  const candidate = resolve(path);
  const root = resolve(repositoryRoot);
  const relation = relative(root, candidate);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error(`${description} must be outside the repository: ${candidate}`);
  }
}

export function assertPathContained(path: string, parent: string, description: string): void {
  const relation = relative(resolve(parent), resolve(path));
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`${description} must be a child of ${resolve(parent)}`);
  }
}
