// VaultTokenMinter real implementation — the per-run scoped child-token mint
// against a live Vault, plus the `ScopedCredentialAccess` factory that builds a
// scoped-token-backed `VaultSecretStore`.
//
// The mint is two Vault calls under the BROAD token:
//   1. POST /v1/sys/policies/acl/<policyName> — write an ACL policy granting the
//      single capability `read` on EXACTLY the KV-v2 data paths for this run's
//      credential refs (`<mount>/data/<ref>`). One stanza per ref; never a glob.
//   2. POST /v1/auth/token/create — create a child token carrying ONLY that
//      policy, with `ttl`, `num_uses`, `renewable:false`, and `no_parent:true`
//      (orphan, so a leaked child cannot be revoked-with-parent-tree nor outlive
//      its bounded TTL via the parent's lease).
//
// The broad token authorizes ONLY these two admin calls; it is never returned in
// the result, never attached to the scoped store, never logged.

import {
  type MintScopedRunTokenInput,
  type ScopedCredentialAccess,
  type ScopedRunToken,
  type VaultTokenMinter,
} from "./vaultTokenMinter.js";
import { VaultSecretStore } from "./secretStore.js";

export interface VaultTokenMinterOptions {
  /** Vault address, e.g. `http://vault:8200`. */
  addr: string;
  /** The BROAD Vault token — used ONLY to write policies + create child tokens. */
  token: string;
  /** The KV v2 mount the credential refs live under (defaults to `secret`). */
  mount?: string;
  fetchImpl?: typeof fetch;
}

/** A safe single-segment matcher for the runId fragment of a policy/display name. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export class VaultRunTokenMinter implements VaultTokenMinter {
  private readonly fetchImpl: typeof fetch;
  private readonly mount: string;

  constructor(private readonly options: VaultTokenMinterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mount = options.mount ?? "secret";
  }

  async mintScopedRunToken(input: MintScopedRunTokenInput): Promise<ScopedRunToken> {
    const refPaths = normalizeRefPaths(input.credentialRefPaths);
    const ttlSeconds = boundedTtl(input.ttlSeconds);
    const numUses = boundedUses(input.numUses);
    if (!SAFE_NAME.test(input.runId)) {
      throw new Error("run id is not a safe Vault policy-name segment");
    }
    const policyName = `tanren-run-${input.runId}`;

    // 1) Write the run-specific read-only policy: one stanza per ref's KV-v2 data
    //    path, capability `read` ONLY. No wildcard, no widening.
    await this.writePolicy(policyName, this.renderPolicy(refPaths));

    // 2) Create the child token carrying ONLY that policy — short TTL, bounded
    //    uses, non-renewable, orphan.
    const token = await this.createChildToken({ policyName, ttlSeconds, numUses, runId: input.runId });

    return { token, policyName, refPaths, ttlSeconds, numUses };
  }

  /** Map an agnostic SecretStore ref to its KV v2 data path stanza, capability `read`. */
  private renderPolicy(refPaths: readonly string[]): string {
    return refPaths
      .map((ref) => {
        const dataPath = `${this.mount}/data/${ref}`;
        // HCL stanza: read-only on this EXACT path (no glob).
        return `path "${dataPath}" {\n  capabilities = ["read"]\n}`;
      })
      .join("\n\n");
  }

  private async writePolicy(policyName: string, policyHcl: string): Promise<void> {
    const response = await this.fetchImpl(this.policyUrl(policyName), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ policy: policyHcl }),
    });
    await assertVaultOk(response, `write scoped run policy ${policyName}`);
  }

  private async createChildToken(args: {
    policyName: string;
    ttlSeconds: number;
    numUses: number;
    runId: string;
  }): Promise<string> {
    const response = await this.fetchImpl(`${this.base()}/v1/auth/token/create`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        policies: [args.policyName],
        // Bounded lifetime + uses; non-renewable; orphan (no-parent).
        ttl: `${args.ttlSeconds}s`,
        explicit_max_ttl: `${args.ttlSeconds}s`,
        num_uses: args.numUses,
        renewable: false,
        no_parent: true,
        // Non-secret label for Vault audit logs.
        display_name: `tanren-run-${args.runId}`,
        meta: { tanren_run_id: args.runId },
      }),
    });
    await assertVaultOk(response, `create scoped run token for ${args.runId}`);
    const body = (await response.json()) as VaultTokenCreateResponse;
    const clientToken = body.auth?.client_token;
    if (typeof clientToken !== "string" || clientToken === "") {
      throw new Error("Vault token create did not return a client_token");
    }
    return clientToken;
  }

  private policyUrl(policyName: string): string {
    return `${this.base()}/v1/sys/policies/acl/${encodeURIComponent(policyName)}`;
  }

  private base(): string {
    return this.options.addr.replace(/\/$/u, "");
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Vault-Token": this.options.token,
    };
  }
}

/**
 * Build the run's scoped credential access: mint the per-run child token, then
 * wrap a `VaultSecretStore` that reads through THAT token. The returned `secrets`
 * is what the per-run materialization path uses; `scope` is the non-secret audit
 * material (ref paths + TTL/uses) safe to record on an event. The broad token
 * never reaches this store.
 */
export async function buildScopedCredentialAccess(args: {
  minter: VaultTokenMinter;
  addr: string;
  mount?: string;
  fetchImpl?: typeof fetch;
  input: MintScopedRunTokenInput;
}): Promise<ScopedCredentialAccess> {
  const minted = await args.minter.mintScopedRunToken(args.input);
  const secrets = new VaultSecretStore({
    addr: args.addr,
    token: minted.token,
    ...(args.mount === undefined ? {} : { mount: args.mount }),
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
  });
  const { token: _token, ...scope } = minted;
  void _token;
  return { secrets, scope };
}

/** Deduplicate + sort the run's ref paths and reject an empty / unsafe set. */
function normalizeRefPaths(refPaths: readonly string[]): string[] {
  const cleaned = [...new Set(refPaths.map((ref) => ref.trim()).filter((ref) => ref !== ""))].sort();
  if (cleaned.length === 0) {
    throw new Error("scoped run token requires at least one credential ref path");
  }
  for (const ref of cleaned) {
    // A ref must not smuggle a Vault glob (`*`) or climb the path (`..`) that
    // would widen the policy beyond the run's own credentials.
    if (ref.includes("*") || ref.split("/").includes("..")) {
      throw new Error(`credential ref path is not safe to scope a policy on: ${ref}`);
    }
  }
  return cleaned;
}

function boundedTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("scoped run token requires a positive TTL");
  }
  return Math.floor(ttlSeconds);
}

function boundedUses(numUses: number): number {
  if (!Number.isInteger(numUses) || numUses <= 0) {
    throw new Error("scoped run token requires a positive num_uses");
  }
  return numUses;
}

interface VaultTokenCreateResponse {
  auth?: {
    client_token?: string;
  };
}

async function assertVaultOk(response: Response, operation: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`Vault ${operation} failed: ${response.status} ${await response.text()}`);
  }
}
