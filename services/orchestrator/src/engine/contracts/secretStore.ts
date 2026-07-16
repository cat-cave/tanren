export interface SecretValue {
  ref: string;
  value: string;
}

/**
 * Create-only write result. Never includes secret values.
 * - created: path was empty and write accepted
 * - already_exists_identical: path occupied with the same value (idempotent success)
 * - conflict_different_value: path occupied with a different value (hard conflict)
 */
export type PutCreateOnlyResult =
  | { status: "created" }
  | { status: "already_exists_identical" }
  | { status: "conflict_different_value" };

export interface SecretStore {
  put(secret: SecretValue): Promise<void>;
  /**
   * Create-only write. Must not overwrite an existing coordinate.
   * Vault KV v2 uses `options.cas = 0`. Identical prior write is idempotent success.
   * Never logs or returns plaintext beyond the status discriminant.
   */
  putCreateOnly(secret: SecretValue): Promise<PutCreateOnlyResult>;
  get(ref: string): Promise<SecretValue | undefined>;
  delete(ref: string): Promise<void>;
  /**
   * Enumerate the agnostic refs currently stored whose ref starts with
   * `prefix`. Returns the refs only (never the secret values), in no guaranteed
   * order; a prefix that matches nothing returns `[]`. This is the durability
   * seam the credential registry stands on: a restarted process recovers its
   * credential LIST by re-listing the registry-record prefix from the store.
   */
  list(prefix: string): Promise<string[]>;
}

export interface VaultSecretStoreOptions {
  addr: string;
  token: string;
  mount?: string;
  fetchImpl?: typeof fetch;
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async put(secret: SecretValue): Promise<void> {
    this.values.set(secret.ref, secret.value);
  }

  async putCreateOnly(secret: SecretValue): Promise<PutCreateOnlyResult> {
    const existing = this.values.get(secret.ref);
    if (existing === undefined) {
      this.values.set(secret.ref, secret.value);
      return { status: "created" };
    }
    if (existing === secret.value) {
      return { status: "already_exists_identical" };
    }
    return { status: "conflict_different_value" };
  }

  async get(ref: string): Promise<SecretValue | undefined> {
    const value = this.values.get(ref);
    return value === undefined ? undefined : { ref, value };
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((ref) => ref.startsWith(prefix));
  }
}

export class FakeSecretStore extends InMemorySecretStore {}

export class VaultSecretStore implements SecretStore {
  private readonly fetchImpl: typeof fetch;
  private readonly mount: string;

  constructor(private readonly options: VaultSecretStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mount = options.mount ?? "secret";
  }

  async put(secret: SecretValue): Promise<void> {
    const response = await this.fetchImpl(this.url(secret.ref), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ data: { value: secret.value } }),
    });
    await assertVaultOk(response, `store secret ${secret.ref}`);
  }

  /**
   * Vault KV v2 create-only via `options.cas = 0` (write only when version is 0 /
   * path does not exist). On 412, read back and classify identical vs different
   * without returning plaintext. Response-loss after accept: readback of identical
   * value is idempotent success — never delete an ambiguous write.
   */
  async putCreateOnly(secret: SecretValue): Promise<PutCreateOnlyResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(secret.ref), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ options: { cas: 0 }, data: { value: secret.value } }),
      });
    } catch {
      // Accepted-but-response-lost / network blip: read back without deleting.
      return this.classifyCreateOnlyReadback(secret);
    }
    if (response.ok) {
      return { status: "created" };
    }
    if (response.status === 412) {
      return this.classifyCreateOnlyReadback(secret);
    }
    // Decode Vault error without leaking secret material (body is error JSON/text).
    const detail = await response.text();
    throw new Error(`Vault create-only secret ${secret.ref} failed: ${response.status} ${detail}`);
  }

  private async classifyCreateOnlyReadback(secret: SecretValue): Promise<PutCreateOnlyResult> {
    const existing = await this.get(secret.ref);
    if (existing === undefined) {
      throw new Error(`Vault create-only secret ${secret.ref} failed: conflict without readable prior version`);
    }
    if (existing.value === secret.value) {
      return { status: "already_exists_identical" };
    }
    return { status: "conflict_different_value" };
  }

  async get(ref: string): Promise<SecretValue | undefined> {
    const response = await this.fetchImpl(this.url(ref), { headers: this.headers() });
    if (response.status === 404) {
      return undefined;
    }
    await assertVaultOk(response, `read secret ${ref}`);
    const body = (await response.json()) as VaultKvResponse;
    const value = body.data?.data?.value;
    if (typeof value !== "string") {
      throw new TypeError(`Vault secret ${ref} did not contain a string value`);
    }
    return { ref, value };
  }

  async delete(ref: string): Promise<void> {
    const response = await this.fetchImpl(this.url(ref), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (response.status !== 404) {
      await assertVaultOk(response, `delete secret ${ref}`);
    }
  }

  /**
   * Walk the KV v2 metadata tree under `prefix` and return every leaf ref. Vault
   * stores secrets as a path tree, so `LIST /metadata/<path>` yields immediate
   * children (sub-trees carry a trailing `/`); we descend into sub-trees and
   * collect leaves. The `prefix` need not align to a path boundary — we list the
   * containing directory and keep only refs that string-match `prefix`.
   */
  async list(prefix: string): Promise<string[]> {
    const slash = prefix.lastIndexOf("/");
    const dir = slash === -1 ? "" : prefix.slice(0, slash);
    const refs = await this.listTree(dir);
    return refs.filter((ref) => ref.startsWith(prefix));
  }

  private async listTree(path: string): Promise<string[]> {
    const response = await this.fetchImpl(this.metadataUrl(path), {
      method: "LIST",
      headers: this.headers(),
    });
    if (response.status === 404) {
      return [];
    }
    await assertVaultOk(response, `list secrets under ${path}`);
    const body = (await response.json()) as VaultListResponse;
    const keys = body.data?.keys ?? [];
    const out: string[] = [];
    for (const key of keys) {
      const child = path === "" ? key : `${path}/${key}`;
      if (key.endsWith("/")) {
        out.push(...(await this.listTree(child.replace(/\/$/u, ""))));
      } else {
        out.push(child);
      }
    }
    return out;
  }

  private metadataUrl(path: string): string {
    const base = `${this.options.addr.replace(/\/$/u, "")}/v1/${encodePath(this.mount)}/metadata`;
    return path === "" ? base : `${base}/${encodePath(path)}`;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Vault-Token": this.options.token,
    };
  }

  private url(ref: string): string {
    return `${this.options.addr.replace(/\/$/u, "")}/v1/${encodePath(this.mount)}/data/${encodePath(vaultKeyPath(ref))}`;
  }
}

interface VaultKvResponse {
  data?: {
    data?: {
      value?: unknown;
    };
  };
}

interface VaultListResponse {
  data?: {
    keys?: string[];
  };
}

async function assertVaultOk(response: Response, operation: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`Vault ${operation} failed: ${response.status} ${await response.text()}`);
  }
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Map a secret REF to a Vault KV v2 key path. Refs come in two shapes: bare paths
 * (`credential/github/org/<org>/bot`) and `secret://`-scheme refs minted by the
 * integration-link route + the deploy provisioner (`secret://org/<org>/integration/
 * deploy.vercel/token`). The scheme is a logical marker, not part of the key — left
 * in, its `//` splits into an empty path segment and Vault 404s the write. Strip the
 * leading `secret://`, collapse any resulting double slashes, and drop a leading
 * slash so both ref shapes resolve to a clean key. Bare refs pass through unchanged.
 */
function vaultKeyPath(ref: string): string {
  return ref
    .replace(/^secret:\/\//u, "")
    .replaceAll(/\/{2,}/gu, "/")
    .replace(/^\/+/u, "");
}
