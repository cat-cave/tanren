import { SecretStoreWriteError, type PutCreateOnlyResult, type SecretStore, type SecretValue } from "./secretStore.js";

/**
 * Backend-agnostic credential refs look like
 * `credential/<kind>/<scope>/<owner>/<name>` (or the legacy `runner/...` shapes).
 * Google Secret Manager secret ids must match `[a-zA-Z0-9_-]{1,255}`, so the ref
 * is sanitized: every disallowed character (notably `/`) becomes `_`. The
 * mapping is deterministic and total within the id charset, so a put/get/delete
 * round-trip on the same ref always resolves to the same secret id. See the
 * SecretStore conformance suite for the contract this must satisfy.
 */
export function gcpSecretIdFromRef(ref: string): string {
  const sanitized = ref.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
  // Secret ids cannot be empty and are capped at 255 chars.
  const trimmed = sanitized.slice(0, 255);
  return trimmed === "" ? "_" : trimmed;
}

export interface GcpSecretManagerOptions {
  /** GCP project id that owns the secrets, e.g. `my-project`. */
  project: string;
  /**
   * OAuth2 access token with `secretmanager.admin` (or finer create/access/
   * destroy) scopes. Resolved by the operator's tooling; never read here from
   * the environment and never logged.
   */
  accessToken: string;
  /** API base override (tests point this at a stub). */
  apiBase?: string;
  /** Injectable fetch (tests pass an in-memory stub). */
  fetchImpl?: typeof fetch;
}

interface GcpAccessResponse {
  payload?: { data?: unknown };
}

interface GcpListResponse {
  secrets?: { labels?: Record<string, string> }[];
  nextPageToken?: string;
}

const defaultApiBase = "https://secretmanager.googleapis.com/v1";

// The secret id is a LOSSY sanitization of the ref (`/`→`_`, case-folded? no, but
// `/` collisions are possible), so `list` cannot reconstruct the ref from the id.
// Instead the original ref is preserved LOSSLESSLY as hex split across `ref0..N`
// labels at create time (label values are limited to `[a-z0-9_-]{0,63}`, which
// hex satisfies); `list` reads those labels back and reassembles the ref.
const REF_LABEL_PREFIX = "ref";
const LABEL_CHUNK = 63;

function encodeRefLabels(ref: string): Record<string, string> {
  const hex = Buffer.from(ref, "utf8").toString("hex");
  const labels: Record<string, string> = {};
  for (let i = 0, n = 0; i < hex.length; i += LABEL_CHUNK, n += 1) {
    labels[`${REF_LABEL_PREFIX}${n}`] = hex.slice(i, i + LABEL_CHUNK);
  }
  return labels;
}

function decodeRefLabels(labels: Record<string, string> | undefined): string | undefined {
  if (labels === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  for (let n = 0; ; n += 1) {
    const chunk = labels[`${REF_LABEL_PREFIX}${n}`];
    if (chunk === undefined) {
      break;
    }
    parts.push(chunk);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return Buffer.from(parts.join(""), "hex").toString("utf8");
}

/**
 * {@link SecretStore} backed by Google Secret Manager. Each agnostic ref maps to
 * one Secret (id = {@link gcpSecretIdFromRef}); `put` ensures the secret exists
 * then adds a new version (so repeated puts overwrite the latest value), `get`
 * accesses the `latest` version (undefined when the secret is absent), and
 * `delete` destroys the whole secret (idempotent on 404). All calls go through
 * an injectable `fetch` so the round-trip is exercised by the conformance suite
 * against a mocked backend with no live credentials. Secret values are never
 * logged.
 */
export class GcpSecretManagerStore implements SecretStore {
  readonly createOnlyAtomicity = "unsupported" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly options: GcpSecretManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = (options.apiBase ?? defaultApiBase).replace(/\/$/u, "");
  }

  async put(secret: SecretValue): Promise<void> {
    const id = gcpSecretIdFromRef(secret.ref);
    await this.ensureSecret(id, secret.ref);
    const data = Buffer.from(secret.value, "utf8").toString("base64");
    const response = await this.fetchImpl(`${this.secretUrl(id)}:addVersion`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ payload: { data } }),
    });
    await assertOk(response, `add version for secret ${secret.ref}`);
  }

  async putCreateOnly(secret: SecretValue): Promise<PutCreateOnlyResult> {
    throw new SecretStoreWriteError(
      `GCP Secret Manager cannot atomically create immutable coordinate ${secret.ref}`,
      "definitely_unwritten",
    );
  }

  async get(ref: string): Promise<SecretValue | undefined> {
    const id = gcpSecretIdFromRef(ref);
    const response = await this.fetchImpl(`${this.secretUrl(id)}/versions/latest:access`, {
      headers: this.headers(),
    });
    if (response.status === 404) {
      return undefined;
    }
    await assertOk(response, `access secret ${ref}`);
    const body = (await response.json()) as GcpAccessResponse;
    const data = body.payload?.data;
    if (typeof data !== "string") {
      throw new TypeError(`GCP Secret Manager secret ${ref} did not contain payload data`);
    }
    return { ref, value: Buffer.from(data, "base64").toString("utf8") };
  }

  async delete(ref: string): Promise<void> {
    const id = gcpSecretIdFromRef(ref);
    const response = await this.fetchImpl(this.secretUrl(id), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (response.status !== 404) {
      await assertOk(response, `delete secret ${ref}`);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const refs: string[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.apiBase}/projects/${enc(this.options.project)}/secrets`);
      url.searchParams.set("pageSize", "100");
      if (pageToken !== undefined) {
        url.searchParams.set("pageToken", pageToken);
      }
      const response = await this.fetchImpl(url.toString(), { headers: this.headers() });
      await assertOk(response, `list secrets under ${prefix}`);
      const body = (await response.json()) as GcpListResponse;
      for (const entry of body.secrets ?? []) {
        const ref = decodeRefLabels(entry.labels);
        if (ref !== undefined && ref.startsWith(prefix)) {
          refs.push(ref);
        }
      }
      pageToken = body.nextPageToken;
    } while (pageToken !== undefined && pageToken !== "");
    return refs;
  }

  /** Creates the secret container if it does not already exist (409 = exists). */
  private async ensureSecret(id: string, ref: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.apiBase}/projects/${enc(this.options.project)}/secrets?secretId=${enc(id)}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ replication: { automatic: {} }, labels: encodeRefLabels(ref) }),
      },
    );
    if (response.status === 409) {
      return;
    }
    await assertOk(response, `create secret ${ref}`);
  }

  private secretUrl(id: string): string {
    return `${this.apiBase}/projects/${enc(this.options.project)}/secrets/${enc(id)}`;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.options.accessToken}`,
    };
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

async function assertOk(response: Response, operation: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`GCP Secret Manager ${operation} failed: ${response.status} ${await response.text()}`);
  }
}
