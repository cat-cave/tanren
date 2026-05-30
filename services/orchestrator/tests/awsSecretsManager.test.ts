import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AwsSecretsManagerStore, awsSecretNameFromRef } from "../src/engine/contracts/awsSecretsManager.js";
import { awsSecretsManagerFetch } from "./conformance/fakes/awsSecretsManagerFetch.js";

// A request the store sent, captured verbatim. The transport records every
// outgoing call AND delegates to a backing store, so each test asserts both the
// exact wire shape the store builds (URL/method/headers/target/body, SigV4
// signature) and the observable put/get/delete outcome — never spy-only.
interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordingAwsFetch(): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const backing = awsSecretsManagerFetch();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return backing(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const baseOptions = {
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-key-material",
  region: "us-east-1",
};

function sigHash(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

function sigHmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

// Independent reference implementation of the SigV4 signature the store must
// produce, so the canonical-request / string-to-sign / signing-key mutants
// (header list, "POST"/"/" parts, "\n"/";" joins, "aws4_request", "AWS4"
// prefix, "utf8"/"sha256"/"hex", service name, scope) all die: any change to the
// algorithm yields a signature that fails this equality.
function expectedSignature(args: {
  method: string;
  headers: Record<string, string>;
  body: string;
  amzDate: string;
  region: string;
  secretKey: string;
}): string {
  const { headers, body, amzDate, region, secretKey } = args;
  const dateStamp = amzDate.slice(0, 8);
  const signedNames = Object.keys(headers)
    .filter((h) => h !== "authorization")
    .sort();
  const canonicalHeaders = signedNames.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = signedNames.join(";");
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sigHash(body)].join("\n");
  const scope = `${dateStamp}/${region}/secretsmanager/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sigHash(canonicalRequest)].join("\n");
  const kDate = sigHmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = sigHmac(kDate, region);
  const kService = sigHmac(kRegion, "secretsmanager");
  const kSigning = sigHmac(kService, "aws4_request");
  return createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
}

function parseAuthorization(value: string): {
  credential: string;
  signedHeaders: string;
  signature: string;
} {
  const credential = /Credential=([^,]+)/u.exec(value)?.[1] ?? "";
  const signedHeaders = /SignedHeaders=([^,]+)/u.exec(value)?.[1] ?? "";
  const signature = /Signature=([0-9a-f]+)/u.exec(value)?.[1] ?? "";
  return { credential, signedHeaders, signature };
}

describe("awsSecretNameFromRef", () => {
  it("uses the ref verbatim with no prefix", () => {
    expect(awsSecretNameFromRef("credential/github_token/org/acme/default")).toBe(
      "credential/github_token/org/acme/default",
    );
  });

  it("prepends a non-empty prefix with a single slash, stripping a trailing slash", () => {
    expect(awsSecretNameFromRef("credential/x", "tanren")).toBe("tanren/credential/x");
    // A trailing slash on the prefix must be stripped so the name has exactly one separator.
    expect(awsSecretNameFromRef("credential/x", "tanren/")).toBe("tanren/credential/x");
  });

  it("treats an empty-string prefix as no prefix", () => {
    expect(awsSecretNameFromRef("credential/x", "")).toBe("credential/x");
  });
});

describe("AwsSecretsManagerStore wire contract", () => {
  it("signs PutSecretValue with the correct SigV4 target, headers and signature", async () => {
    const { fetchImpl, calls } = recordingAwsFetch();
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl });
    // Pre-create so PutSecretValue succeeds on the first call.
    await store.put({ ref: "credential/token", value: "first" });

    const create = calls[0];
    expect(create).toBeDefined();
    // First put on an absent secret: PutSecretValue (not found) then CreateSecret.
    expect(calls.map((c) => c.headers["x-amz-target"])).toEqual([
      "secretsmanager.PutSecretValue",
      "secretsmanager.CreateSecret",
    ]);

    const putCall = calls[0]!;
    expect(putCall.method).toBe("POST");
    expect(putCall.url).toBe("https://secretsmanager.us-east-1.amazonaws.com/");
    expect(putCall.headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(putCall.headers["host"]).toBe("secretsmanager.us-east-1.amazonaws.com");
    expect(JSON.parse(putCall.body)).toEqual({
      SecretId: "credential/token",
      SecretString: "first",
    });

    const createCall = calls[1]!;
    expect(JSON.parse(createCall.body)).toEqual({
      Name: "credential/token",
      SecretString: "first",
    });

    const auth = parseAuthorization(putCall.headers["authorization"] ?? "");
    expect(auth.credential).toMatch(/^AKIAEXAMPLE\/\d{8}\/us-east-1\/secretsmanager\/aws4_request$/u);
    expect(auth.signedHeaders).toBe("content-type;host;x-amz-date;x-amz-target");
    expect(auth.signature).toBe(
      expectedSignature({
        method: "POST",
        headers: {
          "content-type": putCall.headers["content-type"]!,
          host: putCall.headers["host"]!,
          "x-amz-date": putCall.headers["x-amz-date"]!,
          "x-amz-target": putCall.headers["x-amz-target"]!,
        },
        body: putCall.body,
        amzDate: putCall.headers["x-amz-date"]!,
        region: "us-east-1",
        secretKey: "secret-key-material",
      }),
    );

    // Round-trip outcome through the backend.
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "first",
    });
  });

  it("formats x-amz-date as a compact ISO8601 basic stamp and derives the date scope", async () => {
    const { fetchImpl, calls } = recordingAwsFetch();
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl });
    await store.put({ ref: "credential/token", value: "v" });
    const amzDate = calls[0]!.headers["x-amz-date"] ?? "";
    // Compact ISO8601 basic format (8-digit date, T, 6-digit time, Z) — no
    // colons, dashes, or milliseconds.
    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/u);
    const credential = parseAuthorization(calls[0]!.headers["authorization"] ?? "").credential;
    // Scope date stamp is the first 8 chars of the amzDate (date only).
    expect(credential).toContain(`/${amzDate.slice(0, 8)}/`);
  });

  it("includes the session token header only when a session token is configured", async () => {
    const withToken = recordingAwsFetch();
    const storeWith = new AwsSecretsManagerStore({
      ...baseOptions,
      sessionToken: "session-xyz",
      fetchImpl: withToken.fetchImpl,
    });
    await storeWith.put({ ref: "credential/token", value: "v" });
    expect(withToken.calls[0]!.headers["x-amz-security-token"]).toBe("session-xyz");
    // The token header is part of the signed set.
    expect(parseAuthorization(withToken.calls[0]!.headers["authorization"] ?? "").signedHeaders).toContain(
      "x-amz-security-token",
    );

    const without = recordingAwsFetch();
    const storeWithout = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl: without.fetchImpl });
    await storeWithout.put({ ref: "credential/token", value: "v" });
    expect(without.calls[0]!.headers["x-amz-security-token"]).toBeUndefined();
    expect(parseAuthorization(without.calls[0]!.headers["authorization"] ?? "").signedHeaders).not.toContain(
      "x-amz-security-token",
    );
  });

  it("targets the region-specific host and honours an endpoint override", async () => {
    const def = recordingAwsFetch();
    const defStore = new AwsSecretsManagerStore({
      ...baseOptions,
      region: "eu-west-2",
      fetchImpl: def.fetchImpl,
    });
    await defStore.put({ ref: "credential/token", value: "v" });
    expect(def.calls[0]!.url).toBe("https://secretsmanager.eu-west-2.amazonaws.com/");
    expect(def.calls[0]!.headers["host"]).toBe("secretsmanager.eu-west-2.amazonaws.com");

    const override = recordingAwsFetch();
    const overrideStore = new AwsSecretsManagerStore({
      ...baseOptions,
      endpoint: "http://localhost:4566/",
      fetchImpl: override.fetchImpl,
    });
    await overrideStore.put({ ref: "credential/token", value: "v" });
    // Trailing slash normalized to exactly one.
    expect(override.calls[0]!.url).toBe("http://localhost:4566/");
  });

  it("applies a configured name prefix to the SecretId on every action", async () => {
    const { fetchImpl, calls } = recordingAwsFetch();
    const store = new AwsSecretsManagerStore({
      ...baseOptions,
      namePrefix: "tanren",
      fetchImpl,
    });
    await store.put({ ref: "credential/token", value: "v" });
    await store.get("credential/token");
    await store.delete("credential/token");
    const ids = calls.map((c) => {
      const p = JSON.parse(c.body) as { Name?: string; SecretId?: string };
      return p.Name ?? p.SecretId;
    });
    for (const id of ids) {
      expect(id).toBe("tanren/credential/token");
    }
  });

  it("overwrites an existing secret with PutSecretValue alone (no CreateSecret)", async () => {
    const { fetchImpl, calls } = recordingAwsFetch();
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl });
    await store.put({ ref: "credential/token", value: "first" });
    calls.length = 0;
    await store.put({ ref: "credential/token", value: "second" });
    // Second put hits an existing secret: PutSecretValue succeeds, no CreateSecret.
    expect(calls.map((c) => c.headers["x-amz-target"])).toEqual(["secretsmanager.PutSecretValue"]);
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "second",
    });
  });

  it("issues GetSecretValue and returns the SecretString", async () => {
    const { fetchImpl, calls } = recordingAwsFetch();
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl });
    await store.put({ ref: "credential/token", value: "the-value" });
    calls.length = 0;
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "the-value",
    });
    expect(calls[0]!.headers["x-amz-target"]).toBe("secretsmanager.GetSecretValue");
    expect(JSON.parse(calls[0]!.body)).toEqual({ SecretId: "credential/token" });
  });

  it("returns undefined for a missing get (ResourceNotFoundException)", async () => {
    const { fetchImpl } = recordingAwsFetch();
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl });
    await expect(store.get("credential/absent")).resolves.toBeUndefined();
  });

  it("deletes with ForceDeleteWithoutRecovery and is idempotent on a missing secret", async () => {
    const { fetchImpl, calls } = recordingAwsFetch();
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl });
    await store.put({ ref: "credential/token", value: "v" });
    calls.length = 0;
    await store.delete("credential/token");
    expect(calls[0]!.headers["x-amz-target"]).toBe("secretsmanager.DeleteSecret");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      SecretId: "credential/token",
      ForceDeleteWithoutRecovery: true,
    });
    await expect(store.get("credential/token")).resolves.toBeUndefined();
    // Deleting an already-absent secret is a no-op (no throw).
    await expect(store.delete("credential/token")).resolves.toBeUndefined();
  });

  it("throws with status and body on a non-not-found error", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ __type: "AccessDeniedException" }), {
        status: 403,
      })) as typeof fetch;
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl: failing });
    await expect(store.get("credential/x")).rejects.toThrow(
      /AWS Secrets Manager get secret credential\/x failed: 403 .*AccessDeniedException/u,
    );
    await expect(store.put({ ref: "credential/x", value: "v" })).rejects.toThrow(
      /AWS Secrets Manager put secret credential\/x failed: 403/u,
    );
    await expect(store.delete("credential/x")).rejects.toThrow(
      /AWS Secrets Manager delete secret credential\/x failed: 403/u,
    );
  });

  it("throws when a successful GetSecretValue response has no string SecretString", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ SecretString: 42 }), { status: 200 })) as typeof fetch;
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl });
    await expect(store.get("credential/x")).rejects.toThrow(/did not contain a SecretString/u);
  });

  it("throws when the CreateSecret fallback itself fails", async () => {
    // PutSecretValue reports the secret missing, then CreateSecret errors: the
    // create-path assertOk must surface that failure.
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const target = new Headers(init?.headers).get("x-amz-target") ?? "";
      if (target.endsWith("PutSecretValue")) {
        return new Response(JSON.stringify({ __type: "ResourceNotFoundException" }), { status: 400 });
      }
      return new Response("quota exceeded", { status: 500 });
    }) as typeof fetch;
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl });
    await expect(store.put({ ref: "credential/x", value: "v" })).rejects.toThrow(
      /AWS Secrets Manager create secret credential\/x failed: 500 quota exceeded/u,
    );
  });

  it("only treats 400/404 statuses as ResourceNotFoundException — a 500 still throws", async () => {
    // The not-found marker appears in the body, but a 500 is a hard failure: the
    // status gate must reject it rather than swallow it as a missing secret.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ __type: "ResourceNotFoundException" }), {
        status: 500,
      })) as typeof fetch;
    const store = new AwsSecretsManagerStore({ ...baseOptions, fetchImpl });
    await expect(store.get("credential/x")).rejects.toThrow(
      /AWS Secrets Manager get secret credential\/x failed: 500/u,
    );
  });
});
