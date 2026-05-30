import { describe, expect, it } from "vitest";
import { buildAllocatorFromEnv } from "../src/engine/allocators/buildAllocator.js";
import {
  allocReq,
  HETZNER_ENV,
  installAllocatorE2eLifecycle,
  json,
  queryPool,
  stubFetch,
} from "./allocatorE2eHarness.js";

// End-to-end coverage of the router REGISTRY wiring: the `build("<kind>")`
// entries + `case "<kind>"` arms that map each routing kind to its real backing
// allocator. Route the default to each kind in turn and drive allocate() — a
// mis-wired registry entry would throw "not configured" or provision the wrong
// backend, so a green provision of THIS kind (asserted via its imageSha suffix)
// pins the entry. Companion to buildAllocatorE2e.test.ts.

describe("buildAllocatorFromEnv — router registry wires each kind (stubbed fetch)", () => {
  installAllocatorE2eLifecycle();

  // The router registry must wire each named kind to its real backing allocator
  // (the `build("<kind>")` entries + the `case "<kind>"` arms). Route the
  // default to a credentialed cloud kind and drive allocate() end-to-end: a
  // mis-wired registry entry would either throw "not configured" or provision
  // the wrong backend, so a green provisioning of THIS kind pins the entry.
  it("router: a default-routed hetzner kind builds + uses the real hetzner backing allocator", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    Object.assign(process.env, HETZNER_ENV);
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "hetzner" });
    stubFetch(() => json({ server: { id: 300, status: "running", public_net: { ipv4: { ip: "203.0.113.9" } } } }, 201));
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    // hetzner imageSha suffix proves the hetzner backing allocator served it.
    expect(allocation.imageSha).toMatch(/@sha256:hetzner$/u);
    expect(allocation.target.host).toBe("203.0.113.9");
  });

  it("router: a default-routed sidecar kind builds + uses the real sidecar backing allocator", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "sidecar" });
    stubFetch(() =>
      json({
        runnerId: "runner_router_sidecar",
        sshHost: "sidecar-host",
        sshPort: 22,
        hostKeyFingerprint: "SHA256:sc",
        imageSha: "sha256:sc",
      }),
    );
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(allocation.runnerId).toBe("runner_router_sidecar");
    expect(allocation.target.host).toBe("sidecar-host");
  });

  it("router: a default-routed static kind builds + uses the real static backing allocator", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_RUNNER_SSH_HOST_FINGERPRINT = "SHA256:static-pin";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "static" });
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    // static imageSha suffix proves the static backing allocator served it.
    expect(allocation.imageSha).toMatch(/@sha256:static$/u);
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:static-pin");
  });

  it("router: a default-routed manual_ssh kind builds + uses the real manual_ssh backing allocator", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_MANUAL_SSH_HOSTS = JSON.stringify([
      { id: "h1", host: "10.1.1.1", hostKeyFingerprint: "SHA256:m" },
    ]);
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "manual_ssh" });
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(allocation.imageSha).toMatch(/@sha256:manual-ssh$/u);
    expect(allocation.target.host).toBe("10.1.1.1");
  });

  it("router: a default-routed digitalocean kind builds + uses the real DO backing allocator", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_DO_API_TOKEN = "tok";
    process.env.TANREN_DO_HOST_FINGERPRINT = "SHA256:do";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "digitalocean" });
    stubFetch(() =>
      json(
        { droplet: { id: 400, status: "active", networks: { v4: [{ ip_address: "203.0.113.40", type: "public" }] } } },
        202,
      ),
    );
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(allocation.imageSha).toMatch(/@sha256:digitalocean$/u);
    expect(allocation.target.host).toBe("203.0.113.40");
  });

  it("router: a default-routed gcp kind builds + uses the real gcp backing allocator", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_GCP_ACCESS_TOKEN = "tok";
    process.env.TANREN_GCP_PROJECT = "proj-x";
    process.env.TANREN_GCP_ZONE = "us-central1-a";
    process.env.TANREN_GCP_SSH_PUBLIC_KEY = "ssh-ed25519 AAAA";
    process.env.TANREN_GCP_HOST_FINGERPRINT = "SHA256:gcp";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "gcp" });
    stubFetch((url) => {
      if (url.includes("/operations/") || url.endsWith("/instances")) {
        return json({ name: "op-1", status: "DONE" });
      }
      return json({
        name: "tanren-run-e2e",
        status: "RUNNING",
        networkInterfaces: [{ accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "203.0.113.42" }] }],
      });
    });
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(allocation.imageSha).toMatch(/@sha256:gcp$/u);
    expect(allocation.target.host).toBe("203.0.113.42");
  });

  it("router: a default-routed aws_ec2 kind builds + uses the real aws backing allocator", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_AWS_ACCESS_KEY_ID = "AKIA";
    process.env.TANREN_AWS_SECRET_ACCESS_KEY = "secret";
    process.env.TANREN_AWS_REGION = "us-east-1";
    process.env.TANREN_AWS_IMAGE_ID = "ami-123";
    process.env.TANREN_AWS_HOST_FINGERPRINT = "SHA256:aws";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "aws_ec2" });
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const xml = url.includes("RunInstances")
        ? `<RunInstancesResponse><instancesSet><item><instanceId>i-r</instanceId>` +
          `<instanceState><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`
        : `<DescribeInstancesResponse><reservationSet><item><instancesSet><item>` +
          `<instanceId>i-r</instanceId><instanceState><name>running</name></instanceState>` +
          `<ipAddress>203.0.113.43</ipAddress></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`;
      return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
    }) as typeof fetch;
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(allocation.imageSha).toMatch(/@sha256:aws-ec2$/u);
    expect(allocation.target.host).toBe("203.0.113.43");
  });

  it("router: a default-routed kubernetes kind builds + uses the real k8s backing allocator", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "router";
    process.env.TANREN_K8S_API_SERVER = "https://k8s:6443";
    process.env.TANREN_K8S_TOKEN_REF = "tok";
    process.env.TANREN_K8S_NAMESPACE = "tanren-ns";
    process.env.TANREN_K8S_RUNNER_IMAGE = "ghcr.io/x/runner:v0";
    process.env.TANREN_K8S_SSH_PUBLIC_KEY = "ssh-ed25519 AAAA";
    process.env.TANREN_K8S_HOST_FINGERPRINT = "SHA256:k8s";
    process.env.TANREN_ALLOCATOR_ROUTING = JSON.stringify({ defaultAllocator: "kubernetes" });
    stubFetch((url) => {
      if (url.endsWith("/secrets")) {
        return json({}, 201);
      }
      if (url.endsWith("/pods")) {
        return json({ metadata: { name: "tanren-run-e2e" }, status: { phase: "Pending" } }, 201);
      }
      return json({ metadata: { name: "tanren-run-e2e" }, status: { phase: "Running", podIP: "10.5.6.7" } });
    });
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(allocation.imageSha).toMatch(/@sha256:kubernetes$/u);
    expect(allocation.target.host).toBe("10.5.6.7");
  });
});
