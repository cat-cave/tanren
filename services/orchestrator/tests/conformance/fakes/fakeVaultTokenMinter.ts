// FakeVaultTokenMinter — an in-memory VaultTokenMinter for conformance + wiring
// tests. It mints a deterministic scoped token and RECORDS the exact scope
// requested (ref paths, TTL, uses) so a test can assert the security properties
// without a real Vault. Test fixture only — never constructed in production src/.
//
// It applies the SAME normalization invariants the real impl enforces (non-empty,
// deduplicate + sort, reject wildcard/`..`, positive TTL/uses) so conformance
// validates the contract, not one implementation's quirks.

import type {
  MintScopedRunTokenInput,
  ScopedRunToken,
  VaultTokenMinter,
} from "../../../src/engine/contracts/vaultTokenMinter.js";

export class FakeVaultTokenMinter implements VaultTokenMinter {
  /** Every mint's recorded scope (never the token value beyond the fake string). */
  readonly mints: ScopedRunToken[] = [];

  async mintScopedRunToken(input: MintScopedRunTokenInput): Promise<ScopedRunToken> {
    const refPaths = normalize(input.credentialRefPaths);
    if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new Error("scoped run token requires a positive TTL");
    }
    if (!Number.isInteger(input.numUses) || input.numUses <= 0) {
      throw new Error("scoped run token requires a positive num_uses");
    }
    const policyName = `tanren-run-${input.runId}`;
    const minted: ScopedRunToken = {
      // A fake token whose value encodes the policy so a fake transport can map it
      // back to the granted scope. NEVER a real secret.
      token: `fake-child::${policyName}`,
      policyName,
      refPaths,
      ttlSeconds: Math.floor(input.ttlSeconds),
      numUses: input.numUses,
    };
    this.mints.push(minted);
    return minted;
  }
}

function normalize(refPaths: readonly string[]): string[] {
  const cleaned = [...new Set(refPaths.map((r) => r.trim()).filter((r) => r !== ""))].sort();
  if (cleaned.length === 0) {
    throw new Error("scoped run token requires at least one credential ref path");
  }
  for (const ref of cleaned) {
    if (ref.includes("*") || ref.split("/").includes("..")) {
      throw new Error(`credential ref path is not safe to scope a policy on: ${ref}`);
    }
  }
  return cleaned;
}
