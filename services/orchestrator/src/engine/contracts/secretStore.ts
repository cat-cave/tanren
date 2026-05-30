export interface SecretValue {
  ref: string;
  value: string;
}

export interface SecretStore {
  put(secret: SecretValue): Promise<void>;
  get(ref: string): Promise<SecretValue | undefined>;
  delete(ref: string): Promise<void>;
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

  async get(ref: string): Promise<SecretValue | undefined> {
    const value = this.values.get(ref);
    return value === undefined ? undefined : { ref, value };
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
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

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Vault-Token": this.options.token,
    };
  }

  private url(ref: string): string {
    return `${this.options.addr.replace(/\/$/, "")}/v1/${encodePath(this.mount)}/data/${encodePath(ref)}`;
  }
}

interface VaultKvResponse {
  data?: {
    data?: {
      value?: unknown;
    };
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
