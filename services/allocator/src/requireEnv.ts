import { readFileSync } from "node:fs";

/**
 * Require a non-blank env var; throw a clear error when unset/blank (NO fallback).
 * Used for the allocator's required platform config (`MIGRATION_DATABASE_URL`) — no
 * silent fallback to a default / the wrong pool. In its own module so a unit test
 * can import it WITHOUT pulling in `main.ts`'s docker-client construction graph.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required (set it in the environment; there is no default)`);
  }
  return value;
}

/**
 * Require a SECRET, preferring a MOUNTED FILE over a plaintext env value (Codex r5).
 * Precedence — the file WINS:
 *
 *   1. `${name}_FILE` (preferred, prod): read the secret from the mounted file at
 *      boot so the secret VALUE need NOT live as a plaintext env in
 *      `/proc/<pid>/environ` / `docker inspect`. A configured-but-empty/unreadable
 *      file is itself a HARD failure (never a silent blank secret).
 *   2. `name` (dev convenience): a plaintext env value.
 *
 * The allocator's bearer token (`TANREN_ALLOCATOR_TOKEN`) reads through this so the
 * prod compose can mount it as `/run/secrets/tanren_allocator_token`. Mirrors the
 * orchestrator's `requireSecretFromFileOrEnv` precedence on the other end of the
 * sidecar bearer-token pair.
 */
export function requireSecretEnv(name: string): string {
  const filePath = process.env[`${name}_FILE`];
  if (filePath !== undefined && filePath !== "") {
    let contents: string;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch (cause) {
      throw new Error(`${name}_FILE=${filePath} could not be read`, { cause });
    }
    const value = contents.trim();
    if (value === "") {
      throw new Error(`${name}_FILE=${filePath} is empty (no secret in the mounted file)`);
    }
    return value;
  }
  return requireEnv(name);
}
