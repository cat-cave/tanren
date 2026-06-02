/**
 * Require a non-blank env var; throw a clear error when unset/blank (NO fallback).
 * Used for the allocator's `VAULT_TOKEN` — the `?? "dev-root-token"` fallback was
 * removed (managed-hosting dimension D). In its own module so a unit test can
 * import it WITHOUT pulling in `main.ts`'s docker/Vault client construction graph.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required (set it in the environment; there is no default)`);
  }
  return value;
}
