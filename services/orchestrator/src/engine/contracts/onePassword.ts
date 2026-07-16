import type { PutCreateOnlyResult, SecretStore, SecretValue } from "./secretStore.js";

/**
 * Backend-agnostic credential refs (`credential/<kind>/<scope>/<owner>/<name>`,
 * plus legacy `runner/...` shapes) map to a 1Password item **title** inside a
 * single configured vault. The ref is used verbatim as the title (1Password
 * titles allow `/` and arbitrary text), and the value is stored in the item's
 * `password` field. The mapping is deterministic, so a put/get/delete round-trip
 * on the same ref always resolves the same item. Secret values are never logged.
 */
export function onePasswordTitleFromRef(ref: string): string {
  return ref;
}

export interface OnePasswordOptions {
  /** 1Password Connect server URL, e.g. `https://connect.example.com`. */
  connectUrl: string;
  /** Connect API token. Resolved secret; never read from env here. */
  token: string;
  /** Vault id (UUID) that holds the credential items. */
  vaultId: string;
  /** Field label used to carry the secret value (default `password`). */
  fieldLabel?: string;
  /** Injectable fetch (tests pass an in-memory stub). */
  fetchImpl?: typeof fetch;
}

interface OpItemSummary {
  id: string;
  title?: string;
}

interface OpField {
  id?: string;
  label?: string;
  type?: string;
  value?: unknown;
}

interface OpItem {
  id?: string;
  fields?: OpField[];
}

/**
 * {@link SecretStore} backed by the 1Password Connect API (server URL + token).
 * Each agnostic ref maps to one item (title = ref) in a configured vault, with
 * the value carried in a CONCEALED field. `put` creates the item or, when it
 * already exists, replaces it (so repeated puts overwrite); `get` resolves the
 * item by title and returns the field value (undefined when absent); `delete`
 * removes the item (idempotent — a missing item is a no-op). All calls go
 * through an injectable `fetch`, so the round-trip is exercised by the
 * SecretStore conformance suite against a mocked Connect server with no live
 * credentials.
 */
export class OnePasswordStore implements SecretStore {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly fieldLabel: string;

  constructor(private readonly options: OnePasswordOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.base = options.connectUrl.replace(/\/$/u, "");
    this.fieldLabel = options.fieldLabel ?? "password";
  }

  async put(secret: SecretValue): Promise<void> {
    const title = onePasswordTitleFromRef(secret.ref);
    const existing = await this.findItemId(title);
    const item = {
      vault: { id: this.options.vaultId },
      title,
      category: "PASSWORD",
      fields: [{ label: this.fieldLabel, type: "CONCEALED", value: secret.value }],
    };
    const url = existing === undefined ? this.itemsUrl() : this.itemUrl(existing);
    const method = existing === undefined ? "POST" : "PUT";
    const body = existing === undefined ? item : { ...item, id: existing };
    const response = await this.fetchImpl(url, {
      method,
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    await assertOk(response, `store secret ${secret.ref}`);
  }

  async putCreateOnly(secret: SecretValue): Promise<PutCreateOnlyResult> {
    const existing = await this.get(secret.ref);
    if (existing !== undefined) {
      return existing.value === secret.value
        ? { status: "already_exists_identical" }
        : { status: "conflict_different_value" };
    }
    await this.put(secret);
    return { status: "created" };
  }

  async get(ref: string): Promise<SecretValue | undefined> {
    const id = await this.findItemId(onePasswordTitleFromRef(ref));
    if (id === undefined) {
      return undefined;
    }
    const response = await this.fetchImpl(this.itemUrl(id), { headers: this.headers() });
    if (response.status === 404) {
      return undefined;
    }
    await assertOk(response, `read secret ${ref}`);
    const item = (await response.json()) as OpItem;
    const field = (item.fields ?? []).find((f) => f.label === this.fieldLabel);
    if (field === undefined || typeof field.value !== "string") {
      throw new Error(`1Password item for ${ref} did not contain a '${this.fieldLabel}' field`);
    }
    return { ref, value: field.value };
  }

  async delete(ref: string): Promise<void> {
    const id = await this.findItemId(onePasswordTitleFromRef(ref));
    if (id === undefined) {
      return;
    }
    const response = await this.fetchImpl(this.itemUrl(id), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (response.status !== 404) {
      await assertOk(response, `delete secret ${ref}`);
    }
  }

  async list(prefix: string): Promise<string[]> {
    // Item title == ref verbatim, so listing the vault's items and filtering
    // titles by `prefix` recovers the matching refs. The Connect list endpoint
    // returns id+title summaries; no per-item fetch is needed.
    const response = await this.fetchImpl(this.itemsUrl(), { headers: this.headers() });
    if (response.status === 404) {
      return [];
    }
    await assertOk(response, `list items under ${prefix}`);
    const items = (await response.json()) as OpItemSummary[];
    return items
      .map((item) => item.title)
      .filter((title): title is string => typeof title === "string" && title.startsWith(prefix));
  }

  /** Resolves a unique item id by title within the vault, or undefined. */
  private async findItemId(title: string): Promise<string | undefined> {
    const filter = encodeURIComponent(`title eq "${title}"`);
    const response = await this.fetchImpl(`${this.itemsUrl()}?filter=${filter}`, {
      headers: this.headers(),
    });
    if (response.status === 404) {
      return undefined;
    }
    await assertOk(response, `list items for ${title}`);
    const items = (await response.json()) as OpItemSummary[];
    return items.length === 0 ? undefined : items[0]?.id;
  }

  private itemsUrl(): string {
    return `${this.base}/v1/vaults/${encodeURIComponent(this.options.vaultId)}/items`;
  }

  private itemUrl(id: string): string {
    return `${this.itemsUrl()}/${encodeURIComponent(id)}`;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.options.token}`,
    };
  }
}

async function assertOk(response: Response, operation: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`1Password ${operation} failed: ${response.status} ${await response.text()}`);
  }
}
