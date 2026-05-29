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

// buildAllocatorFromEnv is the entry seam main.ts uses to turn operator env
// into a concrete Allocator. These tests pin the *selection outcome* (which
// concrete allocator/registry entry is produced) and the *fail-fast contract*
// (which missing env produces which error) — the behavior mutation survivors
// said was unpinned (buildAllocator.ts was 0% / entirely no-coverage).

// A pg.Pool stand-in. buildAllocatorFromEnv only constructs a PgRunnerStore
// around it; nothing queries during construction, so an empty object suffices.
const fakePool = {} as unknown as pg.Pool;

// Env keys these tests touch; cleared between cases so one test's config never
// leaks into the next.
const ALLOC_ENV_KEYS = [
  "TANREN_ALLOCATOR_KIND",
  "TANREN_ALLOCATOR_ROUTING",
  "TANREN_MANUAL_SSH_HOSTS",
  "TANREN_HETZNER_API_TOKEN",
  "TANREN_HETZNER_HOST_FINGERPRINT",
  "TANREN_DO_API_TOKEN",
  "TANREN_DO_HOST_FINGERPRINT",
  "TANREN_GCP_ACCESS_TOKEN",
  "TANREN_GCP_PROJECT",
  "TANREN_GCP_ZONE",
  "TANREN_GCP_SSH_PUBLIC_KEY",
  "TANREN_GCP_HOST_FINGERPRINT",
  "TANREN_AWS_ACCESS_KEY_ID",
  "TANREN_AWS_SECRET_ACCESS_KEY",
  "TANREN_AWS_REGION",
  "TANREN_AWS_IMAGE_ID",
  "TANREN_AWS_HOST_FINGERPRINT",
  "TANREN_K8S_API_SERVER",
  "TANREN_K8S_TOKEN_REF",
  "TANREN_K8S_NAMESPACE",
  "TANREN_K8S_RUNNER_IMAGE",
  "TANREN_K8S_SSH_PUBLIC_KEY",
  "TANREN_K8S_HOST_FINGERPRINT",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ALLOC_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
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

const HETZNER_ENV = {
  TANREN_HETZNER_API_TOKEN: "tok",
  TANREN_HETZNER_HOST_FINGERPRINT: "SHA256:hz",
};

describe("buildAllocatorFromEnv — single-kind selection", () => {
  it("defaults to the sidecar allocator when no kind is set", () => {
    const allocator = buildAllocatorFromEnv(fakePool);
    expect(allocator).toBeInstanceOf(SidecarHttpAllocator);
  });

  it("treats an unknown kind as sidecar (the documented fallback)", () => {
    process.env.TANREN_ALLOCATOR_KIND = "not-a-real-kind";
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(SidecarHttpAllocator);
  });

  it("selects the static allocator for kind=static", () => {
    process.env.TANREN_ALLOCATOR_KIND = "static";
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(StaticRunnerAllocator);
  });

  it("selects the sidecar allocator for kind=sidecar", () => {
    process.env.TANREN_ALLOCATOR_KIND = "sidecar";
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(SidecarHttpAllocator);
  });

  it("is case-insensitive on the kind (STATIC -> static)", () => {
    process.env.TANREN_ALLOCATOR_KIND = "STATIC";
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(StaticRunnerAllocator);
  });

  it("builds the manual_ssh allocator when its hosts env is present", () => {
    process.env.TANREN_ALLOCATOR_KIND = "manual_ssh";
    process.env.TANREN_MANUAL_SSH_HOSTS = JSON.stringify([
      { id: "h1", host: "10.0.0.1", hostKeyFingerprint: "SHA256:x" },
    ]);
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(ManualSshAllocator);
  });

  it("builds the hetzner allocator when its credentials are present", () => {
    process.env.TANREN_ALLOCATOR_KIND = "hetzner";
    Object.assign(process.env, HETZNER_ENV);
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(HetznerAllocator);
  });

  it("builds the digitalocean allocator when its credentials are present", () => {
    process.env.TANREN_ALLOCATOR_KIND = "digitalocean";
    process.env.TANREN_DO_API_TOKEN = "tok";
    process.env.TANREN_DO_HOST_FINGERPRINT = "SHA256:do";
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(DigitalOceanAllocator);
  });

  it("builds the gcp allocator when its credentials are present", () => {
    process.env.TANREN_ALLOCATOR_KIND = "gcp";
    process.env.TANREN_GCP_ACCESS_TOKEN = "tok";
    process.env.TANREN_GCP_PROJECT = "proj";
    process.env.TANREN_GCP_ZONE = "us-central1-a";
    process.env.TANREN_GCP_SSH_PUBLIC_KEY = "ssh-ed25519 AAAA";
    process.env.TANREN_GCP_HOST_FINGERPRINT = "SHA256:gcp";
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(GcpAllocator);
  });

  it("builds the aws_ec2 allocator when its credentials are present", () => {
    process.env.TANREN_ALLOCATOR_KIND = "aws_ec2";
    process.env.TANREN_AWS_ACCESS_KEY_ID = "AKIA";
    process.env.TANREN_AWS_SECRET_ACCESS_KEY = "secret";
    process.env.TANREN_AWS_REGION = "us-east-1";
    process.env.TANREN_AWS_IMAGE_ID = "ami-123";
    process.env.TANREN_AWS_HOST_FINGERPRINT = "SHA256:aws";
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(AwsEc2Allocator);
  });

  it("builds the kubernetes allocator when its credentials are present", () => {
    process.env.TANREN_ALLOCATOR_KIND = "kubernetes";
    process.env.TANREN_K8S_API_SERVER = "https://k8s";
    process.env.TANREN_K8S_TOKEN_REF = "vault://k8s/token";
    process.env.TANREN_K8S_NAMESPACE = "tanren";
    process.env.TANREN_K8S_RUNNER_IMAGE = "ghcr.io/x/runner:v0";
    process.env.TANREN_K8S_SSH_PUBLIC_KEY = "ssh-ed25519 AAAA";
    process.env.TANREN_K8S_HOST_FINGERPRINT = "SHA256:k8s";
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(KubernetesAllocator);
  });
});

describe("buildAllocatorFromEnv — fail-fast on missing credentials", () => {
  it("throws naming the hosts env when manual_ssh hosts are absent", () => {
    process.env.TANREN_ALLOCATOR_KIND = "manual_ssh";
    expect(() => buildAllocatorFromEnv(fakePool)).toThrow(/TANREN_MANUAL_SSH_HOSTS/);
  });

  it("throws naming hetzner env vars when they are absent", () => {
    process.env.TANREN_ALLOCATOR_KIND = "hetzner";
    expect(() => buildAllocatorFromEnv(fakePool)).toThrow(
      /TANREN_HETZNER_API_TOKEN and TANREN_HETZNER_HOST_FINGERPRINT/,
    );
  });

  it("throws naming digitalocean env vars when they are absent", () => {
    process.env.TANREN_ALLOCATOR_KIND = "digitalocean";
    expect(() => buildAllocatorFromEnv(fakePool)).toThrow(/digitalocean allocator requires/);
  });

  it("throws naming gcp env vars when they are absent", () => {
    process.env.TANREN_ALLOCATOR_KIND = "gcp";
    expect(() => buildAllocatorFromEnv(fakePool)).toThrow(/TANREN_GCP_ACCESS_TOKEN/);
  });

  it("throws naming aws env vars when they are absent", () => {
    process.env.TANREN_ALLOCATOR_KIND = "aws_ec2";
    expect(() => buildAllocatorFromEnv(fakePool)).toThrow(/TANREN_AWS_ACCESS_KEY_ID/);
  });

  it("throws naming kubernetes env vars when they are absent", () => {
    process.env.TANREN_ALLOCATOR_KIND = "kubernetes";
    expect(() => buildAllocatorFromEnv(fakePool)).toThrow(/TANREN_K8S_API_SERVER/);
  });
});

// The cloud builders validate every required env var with an OR-chain guard
// (`a === undefined || b === undefined || ...`). A mutant that flips one `||`
// to `&&` survives unless a test proves that *each individual* missing var
// still trips the guard. These tables drive one "drop exactly one var" case
// per required var, per kind.
const CLOUD_REQUIRED: Record<string, Record<string, string>> = {
  gcp: {
    TANREN_GCP_ACCESS_TOKEN: "tok",
    TANREN_GCP_PROJECT: "proj",
    TANREN_GCP_ZONE: "us-central1-a",
    TANREN_GCP_SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
    TANREN_GCP_HOST_FINGERPRINT: "SHA256:gcp",
  },
  aws_ec2: {
    TANREN_AWS_ACCESS_KEY_ID: "AKIA",
    TANREN_AWS_SECRET_ACCESS_KEY: "secret",
    TANREN_AWS_REGION: "us-east-1",
    TANREN_AWS_IMAGE_ID: "ami-123",
    TANREN_AWS_HOST_FINGERPRINT: "SHA256:aws",
  },
  kubernetes: {
    TANREN_K8S_API_SERVER: "https://k8s",
    TANREN_K8S_TOKEN_REF: "vault://k8s/token",
    TANREN_K8S_NAMESPACE: "tanren",
    TANREN_K8S_RUNNER_IMAGE: "ghcr.io/x/runner:v0",
    TANREN_K8S_SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
    TANREN_K8S_HOST_FINGERPRINT: "SHA256:k8s",
  },
};

describe("buildAllocatorFromEnv — every required cloud var is individually mandatory", () => {
  for (const [kind, required] of Object.entries(CLOUD_REQUIRED)) {
    for (const missing of Object.keys(required)) {
      it(`${kind} throws when only ${missing} is absent`, () => {
        process.env.TANREN_ALLOCATOR_KIND = kind;
        for (const [key, value] of Object.entries(required)) {
          if (key !== missing) {
            process.env[key] = value;
          }
        }
        // Each builder throws "<kind> allocator requires ..." naming its env.
        expect(() => buildAllocatorFromEnv(fakePool)).toThrow(/allocator requires/);
      });
    }

    it(`${kind} succeeds once every required var is present`, () => {
      process.env.TANREN_ALLOCATOR_KIND = kind;
      Object.assign(process.env, required);
      expect(() => buildAllocatorFromEnv(fakePool)).not.toThrow();
    });
  }
});

describe("buildAllocatorFromEnv — router assembly", () => {
  it("requires the routing config env for kind=router", () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    expect(() => buildAllocatorFromEnv(fakePool)).toThrow(/TANREN_ALLOCATOR_ROUTING/);
  });

  it("builds an AllocatorRouter from a valid routing config", () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "sidecar" });
    expect(buildAllocatorFromEnv(fakePool)).toBeInstanceOf(AllocatorRouter);
  });

  it("rejects a routing config with an unknown default kind", () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "bogus" });
    // Zod rejects the unknown enum value when parsing the routing config.
    expect(() => buildAllocatorFromEnv(fakePool)).toThrow(Error);
  });

  it("only builds credentialed cloud kinds that the routing config actually references", () => {
    // hetzner is referenced by a rule AND its credentials are present, so the
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
    const router = buildAllocatorFromEnv(fakePool);
    expect(router).toBeInstanceOf(AllocatorRouter);
  });

  it("throws when the routing config references a cloud kind without its credentials", () => {
    // hetzner is referenced but its env is absent -> the registry build must
    // construct the real allocator (because it is used) and that throws.
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({
      defaultAllocator: "hetzner",
    });
    expect(() => buildAllocatorFromEnv(fakePool)).toThrow(/TANREN_HETZNER_API_TOKEN/);
  });
});
