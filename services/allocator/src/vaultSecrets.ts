import type { RunnerSecretsClient } from "./runnerLifecycle.js";

export interface VaultSecretsClientOptions {
  addr: string;
  token: string;
  mount?: string;
  fetchImpl?: typeof fetch;
}

export class VaultSecretsClient implements RunnerSecretsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly mount: string;

  constructor(private readonly options: VaultSecretsClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mount = options.mount ?? "secret";
  }

  async get(ref: string): Promise<string | undefined> {
    const response = await this.fetchImpl(this.url(ref), {
      headers: { "X-Vault-Token": this.options.token }
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Vault read ${ref} failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { data?: { data?: { value?: unknown } } };
    const value = body.data?.data?.value;
    if (typeof value !== "string") {
      throw new Error(`Vault secret ${ref} did not contain a string value`);
    }
    return value;
  }

  private url(ref: string): string {
    const encoded = ref.split("/").map(encodeURIComponent).join("/");
    return `${this.options.addr.replace(/\/$/, "")}/v1/${encodeURIComponent(this.mount)}/data/${encoded}`;
  }
}

export class StaticSecretsClient implements RunnerSecretsClient {
  constructor(private readonly values: Record<string, string>) {}

  async get(ref: string): Promise<string | undefined> {
    return this.values[ref];
  }
}
