// In-memory `fetch` that emulates the subset of Vault the VaultRunTokenMinter
// drives, and RECORDS every request so a test can assert the exact policy HCL,
// TTL/uses, and orphan/non-renewable flags that were sent. Test fixture only.
//
//   - POST /v1/sys/policies/acl/<name>      → stores the policy HCL, 204
//   - POST /v1/auth/token/create            → returns a deterministic child token
//                                             derived from the requested policy
//   - GET/POST /v1/secret/data/<ref>        → KV v2 read/write the scoped store uses,
//                                             but the GET is AUTHORIZED only if the
//                                             request's X-Vault-Token is a child
//                                             token whose policy covers that ref's
//                                             data path (so a test can prove the
//                                             scope is actually enforced)

export interface RecordedPolicyWrite {
  name: string;
  policyHcl: string;
}

export interface RecordedTokenCreate {
  policies: string[];
  ttl?: string;
  explicitMaxTtl?: string;
  numUses?: number;
  renewable?: boolean;
  noParent?: boolean;
  displayName?: string;
  meta?: Record<string, unknown>;
}

export interface VaultTokenFetchRecorder {
  fetch: typeof fetch;
  policyWrites: RecordedPolicyWrite[];
  tokenCreates: RecordedTokenCreate[];
  /** The broad token presented on the admin (policy/create) calls. */
  adminTokensSeen: string[];
  /** Seed a KV value the scoped store can read back (keyed by ref). */
  seed(ref: string, value: string): void;
  /** Refs read via a GET that was AUTHORIZED by the presented child token. */
  authorizedReads: string[];
  /** Refs whose GET was DENIED (403) because the child token's policy didn't cover it. */
  deniedReads: string[];
}

const dataPath = (url: string): string => decodeURIComponent(url.split("/data/")[1] ?? "");
const policyName = (url: string): string => decodeURIComponent(url.split("/sys/policies/acl/")[1] ?? "");

/**
 * Build a recording Vault fetch. `mount` is the KV v2 mount the policy paths
 * embed (default `secret`). Child tokens are minted as `child::<policyName>`; the
 * fetch parses the policy HCL to learn which `<mount>/data/<ref>` paths that token
 * may read, and enforces it on KV GETs — so a test can prove a scoped token can
 * read ONLY its own run's refs and is DENIED another run's.
 */
export function vaultTokenFetch(mount = "secret"): VaultTokenFetchRecorder {
  const policies = new Map<string, string>();
  const kv = new Map<string, string>();
  const recorder: VaultTokenFetchRecorder = {
    policyWrites: [],
    tokenCreates: [],
    adminTokensSeen: [],
    authorizedReads: [],
    deniedReads: [],
    seed(ref, value) {
      kv.set(ref, value);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const token = headerToken(init);

      if (url.includes("/sys/policies/acl/") && method === "POST") {
        recorder.adminTokensSeen.push(token);
        const body = JSON.parse(asString(init?.body)) as { policy?: string };
        const name = policyName(url);
        policies.set(name, body.policy ?? "");
        recorder.policyWrites.push({ name, policyHcl: body.policy ?? "" });
        return new Response(null, { status: 204 });
      }

      if (url.endsWith("/auth/token/create") && method === "POST") {
        recorder.adminTokensSeen.push(token);
        const body = JSON.parse(asString(init?.body)) as Record<string, unknown>;
        recorder.tokenCreates.push({
          policies: (body["policies"] as string[]) ?? [],
          ttl: body["ttl"] as string | undefined,
          explicitMaxTtl: body["explicit_max_ttl"] as string | undefined,
          numUses: body["num_uses"] as number | undefined,
          renewable: body["renewable"] as boolean | undefined,
          noParent: body["no_parent"] as boolean | undefined,
          displayName: body["display_name"] as string | undefined,
          meta: body["meta"] as Record<string, unknown> | undefined,
        });
        const childPolicy = ((body["policies"] as string[]) ?? [])[0] ?? "";
        return json({ auth: { client_token: `child::${childPolicy}` } });
      }

      // KV v2 read/write the scoped store drives.
      if (url.includes("/data/")) {
        const ref = dataPath(url);
        if (method === "POST") {
          const body = JSON.parse(asString(init?.body)) as { data?: { value?: string } };
          kv.set(ref, body.data?.value ?? "");
          return new Response(null, { status: 204 });
        }
        // GET: enforce the presented child token's policy scope.
        if (!tokenMayRead(token, ref)) {
          recorder.deniedReads.push(ref);
          return new Response("permission denied", { status: 403 });
        }
        recorder.authorizedReads.push(ref);
        const value = kv.get(ref);
        if (value === undefined) {
          return new Response("not found", { status: 404 });
        }
        return json({ data: { data: { value } } });
      }

      return new Response("unexpected request", { status: 500 });
    }) as typeof fetch,
  };

  /** A child token `child::<policyName>` may read `ref` iff its policy's HCL grants it. */
  function tokenMayRead(token: string, ref: string): boolean {
    const prefix = "child::";
    if (!token.startsWith(prefix)) {
      // The broad/admin token (or any non-child token) is not the scoped path the
      // de-privilege test exercises; treat it as NOT authorized so a test that
      // accidentally reads with the broad token over this fetch is visible.
      return false;
    }
    const policyHcl = policies.get(token.slice(prefix.length));
    if (policyHcl === undefined) {
      return false;
    }
    return policyHcl.includes(`path "${mount}/data/${ref}"`);
  }

  return recorder;
}

function headerToken(init?: RequestInit): string {
  const headers = init?.headers;
  if (headers === undefined) {
    return "";
  }
  if (headers instanceof Headers) {
    return headers.get("X-Vault-Token") ?? "";
  }
  const record = headers as Record<string, string>;
  return record["X-Vault-Token"] ?? "";
}

function asString(body: BodyInit | null | undefined): string {
  return typeof body === "string" ? body : "{}";
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
