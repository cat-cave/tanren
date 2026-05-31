import { createHash, createHmac } from "node:crypto";
import type { SecretStore, SecretValue } from "./secretStore.js";

/**
 * Backend-agnostic credential refs (`credential/<kind>/<scope>/<owner>/<name>`,
 * plus legacy `runner/...` shapes) map to an AWS Secrets Manager secret name.
 * The Secrets Manager name charset is broad — it allows `/`, letters, digits and
 * `-_+=.@!` — so the ref is used verbatim as the name (optionally namespaced by
 * a configured prefix). The mapping is deterministic, so a put/get/delete
 * round-trip on the same ref always targets the same secret. Secret values are
 * never logged.
 */
export function awsSecretNameFromRef(ref: string, prefix?: string): string {
  return prefix === undefined || prefix === "" ? ref : `${prefix.replace(/\/$/u, "")}/${ref}`;
}

export interface AwsSecretsManagerOptions {
  /** AWS access key id. Resolved secret; never read from env here. */
  accessKeyId: string;
  /** AWS secret access key. Resolved secret; never read from env here. */
  secretAccessKey: string;
  /** Optional STS session token for temporary credentials. */
  sessionToken?: string;
  /** AWS region, e.g. `us-east-1`. */
  region: string;
  /** Optional name prefix applied to every ref (e.g. `tanren`). */
  namePrefix?: string;
  /** Endpoint override (tests point this at a stub). */
  endpoint?: string;
  /** Injectable fetch (tests pass an in-memory stub). */
  fetchImpl?: typeof fetch;
}

const service = "secretsmanager";
const apiVersion = "secretsmanager.GetSecretValue";

interface GetSecretValueResponse {
  SecretString?: unknown;
}

interface ListSecretsResponse {
  SecretList?: { Name?: unknown }[];
  NextToken?: unknown;
}

/**
 * {@link SecretStore} backed by AWS Secrets Manager via a thin SigV4-signed
 * `fetch` client (mirrors the AWS EC2 allocator — no heavy `@aws-sdk` dependency
 * so the store stays small and injectable). `put` issues `PutSecretValue`,
 * falling back to `CreateSecret` when the secret does not yet exist (so repeated
 * puts overwrite); `get` issues `GetSecretValue` (undefined on
 * `ResourceNotFoundException`); `delete` issues `DeleteSecret` with
 * `ForceDeleteWithoutRecovery` (idempotent — a missing secret is a no-op). The
 * round-trip is exercised by the SecretStore conformance suite against a mocked
 * backend with no live credentials.
 */
export class AwsSecretsManagerStore implements SecretStore {
  private readonly fetchImpl: typeof fetch;
  private readonly host: string;
  private readonly endpoint: string;

  constructor(private readonly options: AwsSecretsManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.host = `secretsmanager.${options.region}.amazonaws.com`;
    this.endpoint = (options.endpoint ?? `https://${this.host}/`).replace(/\/$/u, "") + "/";
  }

  async put(secret: SecretValue): Promise<void> {
    const name = this.name(secret.ref);
    const put = await this.call("PutSecretValue", { SecretId: name, SecretString: secret.value });
    if (put.ok) {
      return;
    }
    const body = await put.text();
    if (isNotFound(put.status, body)) {
      const created = await this.call("CreateSecret", { Name: name, SecretString: secret.value });
      await assertOk(created, `create secret ${secret.ref}`);
      return;
    }
    throw new Error(`AWS Secrets Manager put secret ${secret.ref} failed: ${put.status} ${body}`);
  }

  async get(ref: string): Promise<SecretValue | undefined> {
    const response = await this.call("GetSecretValue", { SecretId: this.name(ref) });
    if (!response.ok) {
      const body = await response.text();
      if (isNotFound(response.status, body)) {
        return undefined;
      }
      throw new Error(`AWS Secrets Manager get secret ${ref} failed: ${response.status} ${body}`);
    }
    const parsed = (await response.json()) as GetSecretValueResponse;
    if (typeof parsed.SecretString !== "string") {
      throw new TypeError(`AWS Secrets Manager secret ${ref} did not contain a SecretString`);
    }
    return { ref, value: parsed.SecretString };
  }

  async delete(ref: string): Promise<void> {
    const response = await this.call("DeleteSecret", {
      SecretId: this.name(ref),
      ForceDeleteWithoutRecovery: true,
    });
    if (response.ok) {
      return;
    }
    const body = await response.text();
    if (isNotFound(response.status, body)) {
      return;
    }
    throw new Error(`AWS Secrets Manager delete secret ${ref} failed: ${response.status} ${body}`);
  }

  async list(prefix: string): Promise<string[]> {
    // Names are `<namePrefix>/<ref>` (verbatim ref when unprefixed), so the
    // wire-level name prefix is the configured store prefix joined with the ref
    // prefix; we page `ListSecrets`, keep names under that, then strip the store
    // prefix to recover the agnostic ref.
    const namePrefix = this.name(prefix);
    const stripLen = namePrefix.length - prefix.length;
    const refs: string[] = [];
    let nextToken: string | undefined;
    do {
      const payload: Record<string, unknown> = { MaxResults: 100 };
      if (nextToken !== undefined) {
        payload["NextToken"] = nextToken;
      }
      const response = await this.call("ListSecrets", payload);
      await assertOk(response, `list secrets under ${prefix}`);
      const parsed = (await response.json()) as ListSecretsResponse;
      for (const entry of parsed.SecretList ?? []) {
        if (typeof entry.Name === "string" && entry.Name.startsWith(namePrefix)) {
          refs.push(entry.Name.slice(stripLen));
        }
      }
      nextToken = typeof parsed.NextToken === "string" ? parsed.NextToken : undefined;
    } while (nextToken !== undefined);
    return refs;
  }

  private name(ref: string): string {
    return awsSecretNameFromRef(ref, this.options.namePrefix);
  }

  /** Signs and sends one Secrets Manager JSON action via SigV4. */
  private async call(action: string, payload: Record<string, unknown>): Promise<Response> {
    const body = JSON.stringify(payload);
    const now = new Date();
    const amzDate = now.toISOString().replaceAll(/[:-]|\.\d{3}/gu, "");
    const dateStamp = amzDate.slice(0, 8);
    const target = apiVersion.replace("GetSecretValue", action);
    const headers: Record<string, string> = {
      "content-type": "application/x-amz-json-1.1",
      host: this.host,
      "x-amz-date": amzDate,
      "x-amz-target": target,
    };
    if (this.options.sessionToken !== undefined) {
      headers["x-amz-security-token"] = this.options.sessionToken;
    }
    headers["authorization"] = this.authorization(headers, body, amzDate, dateStamp);
    return this.fetchImpl(this.endpoint, { method: "POST", headers, body });
  }

  private authorization(headers: Record<string, string>, body: string, amzDate: string, dateStamp: string): string {
    const signedNames = Object.keys(headers)
      .filter((h) => h !== "authorization")
      .sort();
    const canonicalHeaders = signedNames.map((h) => `${h}:${headers[h]}\n`).join("");
    const signedHeaders = signedNames.join(";");
    const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256Hex(body)].join("\n");
    const scope = `${dateStamp}/${this.options.region}/${service}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const key = signingKey(this.options.secretAccessKey, dateStamp, this.options.region);
    const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
    return (
      `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`
    );
  }
}

function isNotFound(status: number, body: string): boolean {
  return status === 400 || status === 404 ? /ResourceNotFoundException/u.test(body) : false;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function signingKey(secretKey: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

async function assertOk(response: Response, operation: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`AWS Secrets Manager ${operation} failed: ${response.status} ${await response.text()}`);
  }
}
