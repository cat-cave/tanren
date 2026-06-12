// VaultTokenMinter — the per-run scoped-credential-access seam (managed-hosting
// dimension D: the last big data-plane de-privilege).
//
// Today a run's credentials (codex/claude/opencode auth, the GitHub token) are
// materialized over the runner using the orchestrator's BROAD Vault token — the
// same token that can read EVERY tenant's secrets. This seam removes that: for a
// single run, it mints a short-lived Vault CHILD token whose policy grants `read`
// ONLY on that run's own credential ref paths (not a wildcard, not another
// run's, not another org's) — PLUS `create`+`update` on the run's ROTATING refs
// (the BYOK Codex ChatGPT bundle, which codex refreshes mid-run and the run must
// persist back), with a bounded TTL + use count, non-renewable and
// orphaned (no-parent). The run's credential reads/materialization then use THAT
// scoped token; the broad token stays only at the orchestrator boot to MINT
// children and is NEVER handed to a runner or logged.
//
// The seam is transport-agnostic so the policy-scoping + mint logic is
// unit-testable against a fake Vault transport (tests/), with conformance asserting
// the security properties every implementation must hold. The real proof is the
// smoke/e2e against a real Vault.
//
// SECURITY PROPERTIES (conformance + the verifier hammer these):
//   - the minted token's policy grants `read` on the exact run's credential ref
//     data paths — never a wildcard, never another run's/org's paths — plus
//     `create`+`update` on the ROTATING subset (always ⊆ the read set, never a new
//     path); a non-rotating ref is read-only and write is granted ONLY where a
//     write-back genuinely happens;
//   - the token carries a bounded TTL and `num_uses`, is non-renewable, and is an
//     orphan (no-parent) so a leaked child cannot outlive its run or renew;
//   - the broad token is used only to call the mint API — it is never returned,
//     emitted, or attached to the scoped result.

import type { SecretStore } from "./secretStore.js";

/** The inputs a single run's scoped-token mint is keyed on. */
export interface MintScopedRunTokenInput {
  /** The owning run — used to name the run-specific policy + token display name. */
  runId: string;
  /**
   * The run's org. Threaded ONLY for the audit record + tenant-isolation
   * assertions; the policy is scoped by REF PATHS (which already embed the org),
   * so a run can only ever name its own org's `credential/.../<orgId>/...` paths.
   * `null`/undefined for a system / null-org job (no org segment in its refs).
   */
  orgId?: string | null;
  /**
   * The EXACT credential ref paths this run reads (agnostic SecretStore refs,
   * e.g. `credential/codex/org/<orgId>/default`, `credential/github/org/<orgId>/bot`).
   * The policy grants `read` on precisely these — deduplicated, never widened to a
   * prefix/wildcard. Must be non-empty; an empty set is a hard error (a run with
   * no credentials to read should not mint a token at all).
   */
  credentialRefPaths: readonly string[];
  /**
   * The subset of `credentialRefPaths` the run may also WRITE BACK — the ROTATING
   * credentials it must persist a refreshed value for. The ONLY member today is the
   * BYOK Codex ChatGPT auth bundle (`credential/codex/...`): codex rotates its
   * access/refresh tokens on each call and writes a NEW `auth.json`; the run must
   * persist that fresh bundle to the secret store, else the next call/run reuses a
   * stale (possibly-revoked) refresh token. The policy grants `read`+`create`+`update`
   * on these and `read` on every other ref. A static credential (a GitHub token, a
   * BYOK api_key) does NOT rotate, so it is never here — write is granted ONLY where a
   * write-back genuinely happens. EVERY entry MUST also appear in `credentialRefPaths`
   * (writable is a CAPABILITY on a ref the run already reads, never a new path); an
   * entry not in the read set is a hard error — it would widen the policy beyond the
   * run's own credentials. Optional / may be empty (a run with no rotating credential).
   */
  writableCredentialRefPaths?: readonly string[];
  /** The child token's TTL in seconds (bounded; the real impl rejects <=0). */
  ttlSeconds: number;
  /**
   * The child token's max use count (bounded). The materialization path reads each
   * ref once, so this is sized to the ref count with a small margin by the caller.
   */
  numUses: number;
}

/**
 * The result of a scoped-token mint. `token` is the short-lived child token the
 * run's credential reads use — it is the ONLY place the value lives and is never
 * logged/emitted. Everything else is non-secret audit material (the ref paths the
 * policy covers, the granted TTL/uses, the policy name) safe to record on an event.
 */
export interface ScopedRunToken {
  /** The short-lived scoped child token. NEVER log or emit this value. */
  token: string;
  /** The run-specific Vault policy the token carries (names the run, no secret). */
  policyName: string;
  /** The exact ref paths the policy granted `read` on (deduped, sorted). Non-secret. */
  refPaths: string[];
  /**
   * The subset of `refPaths` the policy ALSO granted `create`+`update` on — the
   * rotating credentials the run may write back (the BYOK Codex ChatGPT bundle).
   * Deduped + sorted, always a subset of `refPaths`. Empty when the run has no
   * rotating credential. Non-secret audit material (same tenancy as `refPaths`).
   */
  writableRefPaths: string[];
  /** The granted TTL in seconds (non-secret audit material). */
  ttlSeconds: number;
  /** The granted max use count (non-secret audit material). */
  numUses: number;
}

/**
 * Mints short-lived, per-run-scoped Vault child tokens. Constructed at the
 * orchestrator boot from the BROAD Vault token; that broad token is used ONLY to
 * call the Vault policy-write + token-create APIs here and is never returned.
 */
export interface VaultTokenMinter {
  /**
   * Write a run-specific policy covering EXACTLY `input.credentialRefPaths` (no
   * wildcard, no widening) — `read` on all of them, plus `create`+`update` on the
   * `input.writableCredentialRefPaths` rotating subset — and create a child token
   * bound to it — short TTL, bounded `num_uses`, non-renewable, orphan. Returns the
   * scoped token + non-secret audit material.
   */
  mintScopedRunToken(input: MintScopedRunTokenInput): Promise<ScopedRunToken>;
}

/**
 * Builds a `SecretStore` that reads through the run's SCOPED child token instead
 * of the broad one. This is the value handed to the per-run materialization path
 * (the codex/claude/opencode materializers + the GitHub token resolution) so the
 * broad token never reaches a runner. The factory exists on the seam so the wiring
 * point depends on the contract, not the concrete Vault impl.
 */
export interface ScopedCredentialAccess {
  /** A SecretStore whose reads are authorized by the run's scoped child token. */
  readonly secrets: SecretStore;
  /** The non-secret audit material describing the scope (ref paths + TTL/uses). */
  readonly scope: Omit<ScopedRunToken, "token">;
}
