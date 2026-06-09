import { afterEach, beforeEach } from "vitest";
import type pg from "pg";
import { runWithSystemJobScope } from "@tanren/db";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { Allocator, AllocationRequest, RunnerAllocation } from "../src/engine/contracts/allocator.js";

// Canonical Vault refs the cloud-credential tokens are seeded under for the e2e
// cases. The provider-token env vars carry these REF NAMES; `buildAllocatorFromEnv`
// resolves the VALUE through the SecretStore. (Real `<provider>` tokens are never
// plaintext env values — they are Vault refs.)
export const CLOUD_SECRET_REFS = {
  hetznerToken: "cloud/hetzner/api-token",
  doToken: "cloud/do/api-token",
  gcpToken: "cloud/gcp/access-token",
  awsAccessKeyId: "cloud/aws/access-key-id",
  awsSecretAccessKey: "cloud/aws/secret-access-key",
  k8sToken: "cloud/k8s/token",
} as const;

// The secret manager the cloud allocators store the ephemeral SSH private key in,
// PRE-SEEDED with the cloud-credential tokens at their canonical refs (above) so
// the ref-resolving builders materialize a real token value. A fresh store per
// call keeps the e2e cases isolated.
export function memSecrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: CLOUD_SECRET_REFS.hetznerToken, value: "tok" });
  void store.put({ ref: CLOUD_SECRET_REFS.doToken, value: "tok" });
  void store.put({ ref: CLOUD_SECRET_REFS.gcpToken, value: "tok" });
  void store.put({ ref: CLOUD_SECRET_REFS.awsAccessKeyId, value: "AKIA" });
  void store.put({ ref: CLOUD_SECRET_REFS.awsSecretAccessKey, value: "secret" });
  void store.put({ ref: CLOUD_SECRET_REFS.k8sToken, value: "k8s-token" });
  return store;
}

// Shared harness for the buildAllocatorFromEnv end-to-end tests. These cases
// build the allocator straight from env and drive allocate() against a stubbed
// global fetch, so the env-derived configuration is observed flowing into the
// real HTTP request + returned target. Factored out so the two e2e spec files
// stay under the per-file line cap.

// A pg.Pool stand-in: buildAllocatorFromEnv constructs a PgRunnerStore around
// it; allocate() persists the runner mirror row via the RLS write seam. The seam
// now REQUIRES an ambient scope, so `connect()` is provided (the per-job SYSTEM
// scope `allocateScoped` establishes opens a short `runWithSystemScope` for the
// INSERT) — both query paths are no-ops here (the test observes the HTTP, not the
// DB row).
export const queryPool = {
  query: async () => ({ rows: [] }),
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
} as unknown as pg.Pool;

// Drive `allocate()` under a per-job SYSTEM scope — the runner is claimed during
// a run job, and the RLS write seam admits the runner-mirror INSERT only under a
// scope (org / system). The e2e cases have no org, so the system-job scope is the
// null-org worker path; it never silently writes unscoped.
export function allocateScoped(allocator: Allocator, request: AllocationRequest): Promise<RunnerAllocation> {
  return runWithSystemJobScope(() => allocator.allocate(request));
}

// Hetzner now manages SSH + host key itself: only the project token is required,
// and it is a Vault REF (resolved to its value through the SecretStore), never a
// plaintext env token.
export const HETZNER_ENV = {
  TANREN_HETZNER_API_TOKEN_REF: CLOUD_SECRET_REFS.hetznerToken,
};

// A stub `/ssh_keys` create response so the e2e fetch handler can answer the
// ephemeral-key upload the Hetzner allocator does before creating the server.
export const hetznerSshKeyResponse = (id = 7777): Response => json({ ssh_key: { id } }, 201);

export const allocReq = {
  runId: "run_E2E",
  projectId: "proj_e2e",
  runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
  identitySecretRef: "runner/identity",
};

export type CapturedCall = { url: string; method?: string; body?: Record<string, unknown> };

// Every env key the e2e suites touch; cleared before each case and restored
// after so one test's config never leaks into the next.
const ALLOC_ENV_KEYS = [
  "TANREN_ALLOCATOR_KIND",
  "TANREN_ALLOCATOR_ROUTING",
  "TANREN_ALLOCATOR_URL",
  "TANREN_ALLOCATOR_TOKEN",
  "TANREN_MANUAL_SSH_HOSTS",
  "TANREN_HETZNER_API_TOKEN_REF",
  "TANREN_HETZNER_SERVER_TYPE",
  "TANREN_HETZNER_IMAGE",
  "TANREN_HETZNER_LOCATION",
  "TANREN_HETZNER_EXTRA_CLOUD_INIT_WRITE_FILES",
  "TANREN_HETZNER_SSH_USER",
  "TANREN_DO_API_TOKEN_REF",
  "TANREN_DO_HOST_FINGERPRINT",
  "TANREN_DO_REGION",
  "TANREN_DO_SIZE",
  "TANREN_DO_IMAGE",
  "TANREN_DO_SSH_KEYS",
  "TANREN_DO_SSH_USER",
  "TANREN_GCP_ACCESS_TOKEN_REF",
  "TANREN_GCP_PROJECT",
  "TANREN_GCP_ZONE",
  "TANREN_GCP_SSH_PUBLIC_KEY",
  "TANREN_GCP_HOST_FINGERPRINT",
  "TANREN_GCP_MACHINE_TYPE",
  "TANREN_GCP_IMAGE",
  "TANREN_GCP_SSH_USER",
  "TANREN_AWS_ACCESS_KEY_ID_REF",
  "TANREN_AWS_SECRET_ACCESS_KEY_REF",
  "TANREN_AWS_REGION",
  "TANREN_AWS_IMAGE_ID",
  "TANREN_AWS_HOST_FINGERPRINT",
  "TANREN_AWS_INSTANCE_TYPE",
  "TANREN_AWS_KEY_NAME",
  "TANREN_AWS_SUBNET_ID",
  "TANREN_AWS_SECURITY_GROUP_IDS",
  "TANREN_AWS_SESSION_TOKEN_REF",
  "TANREN_AWS_USER_DATA",
  "TANREN_AWS_SSH_USER",
  "TANREN_K8S_API_SERVER",
  "TANREN_K8S_TOKEN_REF",
  "TANREN_K8S_NAMESPACE",
  "TANREN_K8S_RUNNER_IMAGE",
  "TANREN_K8S_SSH_PUBLIC_KEY",
  "TANREN_K8S_HOST_FINGERPRINT",
  "TANREN_K8S_CA_PEM",
  "TANREN_K8S_SSH_USER",
  "TANREN_RUNNER_SSH_HOST",
  "TANREN_RUNNER_SSH_PORT",
  "TANREN_RUNNER_SSH_USER",
  "TANREN_RUNNER_SSH_HOST_FINGERPRINT",
] as const;

const realFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined> = {};

/** Installs the env save/restore + fetch restore lifecycle for an e2e suite. */
export function installAllocatorE2eLifecycle(): void {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ALLOC_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // The sidecar allocator REQUIRES a bearer token (no `"dev"` fallback); set a
    // default so sidecar-building e2e cases construct. Cases that assert the token
    // flows through override it explicitly.
    process.env.TANREN_ALLOCATOR_TOKEN = "dev";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ALLOC_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });
}

/** Stubs the global fetch, recording each call, and returns the recording. */
export function stubFetch(handler: (url: string, init?: RequestInit) => Response): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    let body: Record<string, unknown> | undefined;
    try {
      body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
    } catch {
      body = undefined;
    }
    calls.push({ url, method: init?.method, body });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
