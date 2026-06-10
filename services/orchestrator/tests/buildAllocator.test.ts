import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { buildAllocatorFromEnv } from "../src/engine/allocators/buildAllocator.js";
import { AllocatorRouter } from "../src/engine/allocators/allocatorRouter.js";
import { AwsEc2Allocator } from "../src/engine/allocators/awsEc2Allocator.js";
import { DigitalOceanAllocator } from "../src/engine/allocators/digitalOceanAllocator.js";
import { GcpAllocator } from "../src/engine/allocators/gcpAllocator.js";
import { HetznerAllocator } from "../src/engine/allocators/hetznerAllocator.js";
import { KubernetesAllocator } from "../src/engine/allocators/kubernetesAllocator.js";
import { ManualSshAllocator } from "../src/engine/allocators/manualSshAllocator.js";
import { SidecarHttpAllocator } from "../src/engine/allocators/sidecarHttpAllocator.js";
import { StaticRunnerAllocator } from "../src/engine/allocators/staticRunnerAllocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";

// buildAllocatorFromEnv is the entry seam main.ts uses to turn operator env
// into a concrete Allocator. These tests pin the *selection outcome* (which
// concrete allocator/registry entry is produced) and the *fail-fast contract*
// (which missing config produces which error).
//
// Cloud-provider credentials (Hetzner/DO/GCP/AWS/K8s tokens) are SECRETS: env
// carries only a Vault REF NAME (`*_REF`); `buildAllocatorFromEnv` resolves the
// VALUE through the SecretStore. So these tests SEED the token values at canonical
// refs and point the `*_REF` env vars at those refs — never a plaintext env token.

// A pg.Pool stand-in. buildAllocatorFromEnv only constructs a PgRunnerStore
// around it; nothing queries during construction, so an empty object suffices.
const fakePool = {} as unknown as pg.Pool;

// Canonical refs the cloud-credential tokens are seeded under.
const REF = {
  hetzner: "cloud/hetzner/token",
  do: "cloud/do/token",
  gcp: "cloud/gcp/token",
  awsKeyId: "cloud/aws/key-id",
  awsSecret: "cloud/aws/secret",
  k8s: "cloud/k8s/token",
} as const;

// The secret manager threaded into the builder. Pre-seeded with every cloud token
// so the ref-resolving builders materialize a real value; the Hetzner allocator
// also stores the ephemeral SSH private key here at allocate-time.
function buildSecrets(): InMemorySecretStore {
  const secrets = new InMemorySecretStore();
  void secrets.put({ ref: REF.hetzner, value: "tok" });
  void secrets.put({ ref: REF.do, value: "tok" });
  void secrets.put({ ref: REF.gcp, value: "tok" });
  void secrets.put({ ref: REF.awsKeyId, value: "AKIA" });
  void secrets.put({ ref: REF.awsSecret, value: "secret" });
  void secrets.put({ ref: REF.k8s, value: "k8s-token" });
  return secrets;
}

let secrets = buildSecrets();
const getSecrets = (): InMemorySecretStore => secrets;

// Env keys these tests touch; cleared between cases so one test's config never
// leaks into the next. The provider tokens are now `*_REF` ref names.
const ALLOC_ENV_KEYS = [
  "TANREN_ALLOCATOR_KIND",
  "TANREN_ALLOCATOR_ROUTING",
  "TANREN_ALLOCATOR_TOKEN",
  "TANREN_MANUAL_SSH_HOSTS",
  "TANREN_HETZNER_API_TOKEN_REF",
  "TANREN_DO_API_TOKEN_REF",
  "TANREN_DO_HOST_FINGERPRINT",
  "TANREN_GCP_ACCESS_TOKEN_REF",
  "TANREN_GCP_PROJECT",
  "TANREN_GCP_ZONE",
  "TANREN_GCP_SSH_PUBLIC_KEY",
  "TANREN_GCP_HOST_FINGERPRINT",
  "TANREN_AWS_ACCESS_KEY_ID_REF",
  "TANREN_AWS_SECRET_ACCESS_KEY_REF",
  "TANREN_AWS_REGION",
  "TANREN_AWS_IMAGE_ID",
  "TANREN_AWS_HOST_FINGERPRINT",
  "TANREN_K8S_API_SERVER",
  "TANREN_K8S_TOKEN_REF",
  "TANREN_K8S_NAMESPACE",
  "TANREN_K8S_RUNNER_IMAGE",
  "TANREN_K8S_SSH_PUBLIC_KEY",
  "TANREN_K8S_HOST_FINGERPRINT",
  // The static-runner SSH topology env (deploy infra). The port goes through a
  // validated parse — a malformed value fails loud (finding #6 tighten).
  "TANREN_RUNNER_SSH_HOST",
  "TANREN_RUNNER_SSH_PORT",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  secrets = buildSecrets();
  savedEnv = {};
  for (const key of ALLOC_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The sidecar allocator REQUIRES a bearer token (no `"dev"` fallback). Set one
  // by default so the sidecar-building cases (default / unknown-kind / sidecar /
  // router-default) construct; cases asserting the loud throw clear it.
  process.env.TANREN_ALLOCATOR_TOKEN = "test-token";
});

afterEach(() => {
  for (const key of ALLOC_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// Hetzner manages SSH + host key itself now: only the project token ref is needed.
const HETZNER_ENV = {
  TANREN_HETZNER_API_TOKEN_REF: REF.hetzner,
};

describe("buildAllocatorFromEnv — single-kind selection", () => {
  it("defaults to the sidecar allocator when no kind is set", async () => {
    const allocator = await buildAllocatorFromEnv(fakePool, secrets);
    expect(allocator).toBeInstanceOf(SidecarHttpAllocator);
  });

  // Finding #1: an unknown/typo'd kind must FAIL LOUD — it must NOT silently
  // degrade to the sidecar allocator (which would run the wrong substrate under a
  // misconfiguration). Only an UNSET kind resolves to the documented default.
  it("throws on an unknown/typo'd kind (never a silent sidecar)", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "not-a-real-kind";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/not a known allocator kind/u);
  });

  it("an UNSET kind resolves to the documented default (sidecar)", async () => {
    delete process.env.TANREN_ALLOCATOR_KIND;
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(SidecarHttpAllocator);
  });

  it("selects the static allocator for kind=static", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "static";
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(StaticRunnerAllocator);
  });

  // Finding #6 (tighten): the runner SSH port is deploy-infra env (correct — NOT
  // per-org config), but a malformed value must FAIL LOUD, not silently become
  // NaN/0 via the old `Number(env(...) ?? 22)`.
  it("throws on a non-numeric TANREN_RUNNER_SSH_PORT (never a silent NaN)", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "static";
    process.env.TANREN_RUNNER_SSH_PORT = "not-a-port";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/is not a valid TCP port/u);
  });

  it("throws on an out-of-range TANREN_RUNNER_SSH_PORT (0 / >65535)", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "static";
    process.env.TANREN_RUNNER_SSH_PORT = "70000";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/is not a valid TCP port/u);
  });

  it("UNSET TANREN_RUNNER_SSH_PORT uses the documented default (static builds cleanly)", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "static";
    delete process.env.TANREN_RUNNER_SSH_PORT;
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(StaticRunnerAllocator);
  });

  it("a valid TANREN_RUNNER_SSH_PORT is accepted", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "static";
    process.env.TANREN_RUNNER_SSH_PORT = "2222";
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(StaticRunnerAllocator);
  });

  it("selects the sidecar allocator for kind=sidecar", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "sidecar";
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(SidecarHttpAllocator);
  });

  it("throws when the sidecar allocator token env is missing (no 'dev' fallback)", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "sidecar";
    delete process.env.TANREN_ALLOCATOR_TOKEN;
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/TANREN_ALLOCATOR_TOKEN is required/u);
  });

  it("is case-insensitive on the kind (STATIC -> static)", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "STATIC";
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(StaticRunnerAllocator);
  });

  it("builds the manual_ssh allocator when its hosts env is present", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "manual_ssh";
    process.env.TANREN_MANUAL_SSH_HOSTS = JSON.stringify([
      { id: "h1", host: "10.0.0.1", hostKeyFingerprint: "SHA256:x" },
    ]);
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(ManualSshAllocator);
  });

  it("builds the hetzner allocator when its credential ref resolves", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "hetzner";
    Object.assign(process.env, HETZNER_ENV);
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(HetznerAllocator);
  });

  it("builds the digitalocean allocator when its credential ref resolves", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "digitalocean";
    process.env.TANREN_DO_API_TOKEN_REF = REF.do;
    process.env.TANREN_DO_HOST_FINGERPRINT = "SHA256:do";
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(DigitalOceanAllocator);
  });

  it("builds the gcp allocator when its credential ref resolves", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "gcp";
    process.env.TANREN_GCP_ACCESS_TOKEN_REF = REF.gcp;
    process.env.TANREN_GCP_PROJECT = "proj";
    process.env.TANREN_GCP_ZONE = "us-central1-a";
    process.env.TANREN_GCP_SSH_PUBLIC_KEY = "ssh-ed25519 AAAA";
    process.env.TANREN_GCP_HOST_FINGERPRINT = "SHA256:gcp";
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(GcpAllocator);
  });

  it("builds the aws_ec2 allocator when its credential refs resolve", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "aws_ec2";
    process.env.TANREN_AWS_ACCESS_KEY_ID_REF = REF.awsKeyId;
    process.env.TANREN_AWS_SECRET_ACCESS_KEY_REF = REF.awsSecret;
    process.env.TANREN_AWS_REGION = "us-east-1";
    process.env.TANREN_AWS_IMAGE_ID = "ami-123";
    process.env.TANREN_AWS_HOST_FINGERPRINT = "SHA256:aws";
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(AwsEc2Allocator);
  });

  it("builds the kubernetes allocator when its credential ref resolves", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "kubernetes";
    process.env.TANREN_K8S_API_SERVER = "https://k8s";
    process.env.TANREN_K8S_TOKEN_REF = REF.k8s;
    process.env.TANREN_K8S_NAMESPACE = "tanren";
    process.env.TANREN_K8S_RUNNER_IMAGE = "ghcr.io/x/runner:v0";
    process.env.TANREN_K8S_SSH_PUBLIC_KEY = "ssh-ed25519 AAAA";
    process.env.TANREN_K8S_HOST_FINGERPRINT = "SHA256:k8s";
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(KubernetesAllocator);
  });
});

describe("buildAllocatorFromEnv — fail-fast on missing credentials", () => {
  it("throws naming the hosts env when manual_ssh hosts are absent", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "manual_ssh";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/TANREN_MANUAL_SSH_HOSTS/u);
  });

  it("throws naming the hetzner token-ref env when it is absent", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "hetzner";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/TANREN_HETZNER_API_TOKEN_REF/u);
  });

  it("throws naming digitalocean env vars when they are absent", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "digitalocean";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/digitalocean allocator requires/u);
  });

  it("throws naming gcp env vars when they are absent", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "gcp";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/TANREN_GCP_ACCESS_TOKEN_REF/u);
  });

  it("throws naming aws env vars when they are absent", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "aws_ec2";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/TANREN_AWS_ACCESS_KEY_ID_REF/u);
  });

  it("throws naming kubernetes env vars when they are absent", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "kubernetes";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/TANREN_K8S_API_SERVER/u);
  });

  it("throws when a Hetzner token REF is set but resolves to NOTHING (no silent empty token)", async () => {
    // The ref-resolution path must fail loud when env names a ref the secret store
    // does not hold — a secret VALUE is never defaulted to empty.
    process.env.TANREN_ALLOCATOR_KIND = "hetzner";
    process.env.TANREN_HETZNER_API_TOKEN_REF = "cloud/hetzner/does-not-exist";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/did not resolve to a Hetzner API token/u);
  });
});

// The cloud builders validate every required env var with an OR-chain guard
// (`a === undefined || b === undefined || ...`). A mutant that flips one `||`
// to `&&` survives unless a test proves that *each individual* missing var
// still trips the guard. These tables drive one "drop exactly one var" case
// per required var, per kind. Token slots carry their `*_REF` ref name.
const CLOUD_REQUIRED: Record<string, Record<string, string>> = {
  hetzner: {
    TANREN_HETZNER_API_TOKEN_REF: REF.hetzner,
  },
  digitalocean: {
    TANREN_DO_API_TOKEN_REF: REF.do,
    TANREN_DO_HOST_FINGERPRINT: "SHA256:do",
  },
  gcp: {
    TANREN_GCP_ACCESS_TOKEN_REF: REF.gcp,
    TANREN_GCP_PROJECT: "proj",
    TANREN_GCP_ZONE: "us-central1-a",
    TANREN_GCP_SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
    TANREN_GCP_HOST_FINGERPRINT: "SHA256:gcp",
  },
  aws_ec2: {
    TANREN_AWS_ACCESS_KEY_ID_REF: REF.awsKeyId,
    TANREN_AWS_SECRET_ACCESS_KEY_REF: REF.awsSecret,
    TANREN_AWS_REGION: "us-east-1",
    TANREN_AWS_IMAGE_ID: "ami-123",
    TANREN_AWS_HOST_FINGERPRINT: "SHA256:aws",
  },
  kubernetes: {
    TANREN_K8S_API_SERVER: "https://k8s",
    TANREN_K8S_TOKEN_REF: REF.k8s,
    TANREN_K8S_NAMESPACE: "tanren",
    TANREN_K8S_RUNNER_IMAGE: "ghcr.io/x/runner:v0",
    TANREN_K8S_SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
    TANREN_K8S_HOST_FINGERPRINT: "SHA256:k8s",
  },
};

// Extracted out of the loop so the per-kind `it` callbacks do not close over the
// `let secrets` (re-bound each `beforeEach`) inside a loop — `no-loop-func`. The
// helpers read the live `secrets` through the stable `getSecrets` accessor.
function expectMissingVarThrows(kind: string, required: Record<string, string>, missing: string): void {
  it(`${kind} throws when only ${missing} is absent`, async () => {
    process.env.TANREN_ALLOCATOR_KIND = kind;
    for (const [key, value] of Object.entries(required)) {
      if (key !== missing) {
        process.env[key] = value;
      }
    }
    // Each builder throws "<kind> allocator requires ..." naming its env.
    await expect(buildAllocatorFromEnv(fakePool, getSecrets())).rejects.toThrow(/allocator requires/u);
  });
}

function expectAllPresentSucceeds(kind: string, required: Record<string, string>): void {
  it(`${kind} succeeds once every required var is present`, async () => {
    process.env.TANREN_ALLOCATOR_KIND = kind;
    Object.assign(process.env, required);
    await expect(buildAllocatorFromEnv(fakePool, getSecrets())).resolves.not.toThrow();
  });
}

describe("buildAllocatorFromEnv — every required cloud var is individually mandatory", () => {
  for (const [kind, required] of Object.entries(CLOUD_REQUIRED)) {
    for (const missing of Object.keys(required)) {
      expectMissingVarThrows(kind, required, missing);
    }
    expectAllPresentSucceeds(kind, required);
  }
});

describe("buildAllocatorFromEnv — router assembly", () => {
  it("requires the routing config env for kind=router", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/TANREN_ALLOCATOR_ROUTING/u);
  });

  it("builds an AllocatorRouter from a valid routing config", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "sidecar" });
    expect(await buildAllocatorFromEnv(fakePool, secrets)).toBeInstanceOf(AllocatorRouter);
  });

  it("rejects a routing config with an unknown default kind", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "bogus" });
    // Zod rejects the unknown enum value when parsing the routing config.
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(Error);
  });

  it("only builds credentialed cloud kinds that the routing config actually references", async () => {
    // hetzner is referenced by a rule AND its credential ref resolves, so the
    // registry must construct a real HetznerAllocator. The other cloud kinds
    // are unreferenced, so they resolve to UnconfiguredAllocator stubs and the
    // router never demands their (absent) credentials at build time. If the
    // build eagerly constructed every kind, this would throw on missing env.
    process.env.TANREN_ALLOCATOR_KIND = "router";
    Object.assign(process.env, HETZNER_ENV);
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: { tier: "gpu" }, allocator: "hetzner" }],
    });
    const router = await buildAllocatorFromEnv(fakePool, secrets);
    expect(router).toBeInstanceOf(AllocatorRouter);
  });

  it("throws when the routing config references a cloud kind without its credentials", async () => {
    // hetzner is referenced but its token-ref env is absent -> the registry build
    // must construct the real allocator (because it is used) and that throws.
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({
      defaultAllocator: "hetzner",
    });
    await expect(buildAllocatorFromEnv(fakePool, secrets)).rejects.toThrow(/TANREN_HETZNER_API_TOKEN_REF/u);
  });
});
