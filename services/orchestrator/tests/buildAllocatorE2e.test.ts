import { describe, expect, it } from "vitest";
import { buildAllocatorFromEnv } from "../src/engine/allocators/buildAllocator.js";
import {
  allocReq,
  type CapturedCall,
  HETZNER_ENV,
  installAllocatorE2eLifecycle,
  json,
  queryPool,
  stubFetch,
} from "./allocatorE2eHarness.js";

// End-to-end: build a cloud/static allocator straight from env (leaving the
// optional vars unset so the documented DEFAULTS apply, or overriding them) and
// actually drive allocate(). The provisioning HTTP goes through the real fetch
// client, so a stubbed global fetch lets us observe the *configured* values that
// flow from env -> builder -> allocator -> request/target. This pins the
// `?? "<default>"` fallbacks the "is this the right class" tests cannot reach.
// Router-registry wiring lives in buildAllocatorRouterE2e.test.ts.

describe("buildAllocatorFromEnv — env defaults flow through allocate() (stubbed fetch)", () => {
  installAllocatorE2eLifecycle();

  it("hetzner: default server type / image / root user from env flow into the provisioning call + target", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "hetzner";
    Object.assign(process.env, HETZNER_ENV);
    const calls = stubFetch((url) => {
      if (url.endsWith("/servers")) {
        return json({ server: { id: 100, status: "running", public_net: { ipv4: { ip: "203.0.113.1" } } } }, 201);
      }
      // getServer: already running with an IP.
      return json({ server: { id: 100, status: "running", public_net: { ipv4: { ip: "203.0.113.1" } } } });
    });
    const allocator = buildAllocatorFromEnv(queryPool);
    const allocation = await allocator.allocate(allocReq);

    const create = calls.find((c) => c.url.endsWith("/servers") && c.method === "POST");
    // Defaults from buildHetzner: server_type cx22, image docker-ce.
    expect(create?.body?.server_type).toBe("cx22");
    expect(create?.body?.image).toBe("docker-ce");
    // Authorization carries the env token (Bearer <token>).
    expect(allocation.target.host).toBe("203.0.113.1");
    // Default ssh user is root.
    expect(allocation.target.username).toBe("root");
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:hz");
  });

  it("hetzner: env overrides for server type / image / location / ssh keys / user beat the defaults", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "hetzner";
    Object.assign(process.env, HETZNER_ENV);
    process.env.TANREN_HETZNER_SERVER_TYPE = "cx42";
    process.env.TANREN_HETZNER_IMAGE = "ubuntu-24.04";
    process.env.TANREN_HETZNER_LOCATION = "hel1";
    process.env.TANREN_HETZNER_SSH_KEYS = "key-a, key-b";
    process.env.TANREN_HETZNER_SSH_USER = "deploy";
    const calls = stubFetch(() =>
      json({ server: { id: 101, status: "running", public_net: { ipv4: { ip: "203.0.113.2" } } } }, 201),
    );
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    const create = calls.find((c) => c.method === "POST");
    expect(create?.body?.server_type).toBe("cx42");
    expect(create?.body?.image).toBe("ubuntu-24.04");
    expect(create?.body?.location).toBe("hel1");
    // The CSV ssh-keys env is split + trimmed into an array.
    expect(create?.body?.ssh_keys).toEqual(["key-a", "key-b"]);
    expect(allocation.target.username).toBe("deploy");
  });

  // The `env` helper coalesces an EMPTY-STRING env value to undefined, so an
  // empty override must still fall back to the documented default (here: root).
  it("hetzner: an empty-string ssh-user env still falls back to the root default", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "hetzner";
    Object.assign(process.env, HETZNER_ENV);
    process.env.TANREN_HETZNER_SSH_USER = "";
    stubFetch(() => json({ server: { id: 102, status: "running", public_net: { ipv4: { ip: "203.0.113.8" } } } }, 201));
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(allocation.target.username).toBe("root");
  });

  it("digitalocean: default region / size / image / root user from env flow into the create call + target", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "digitalocean";
    process.env.TANREN_DO_API_TOKEN = "tok";
    process.env.TANREN_DO_HOST_FINGERPRINT = "SHA256:do";
    const droplet = {
      droplet: { id: 200, status: "active", networks: { v4: [{ ip_address: "203.0.113.3", type: "public" }] } },
    };
    const calls = stubFetch(() => json(droplet, 202));
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);

    const create = calls.find((c) => c.url.endsWith("/droplets") && c.method === "POST");
    // Defaults from buildDigitalOcean: region nyc3, size s-1vcpu-1gb, image docker-20-04.
    expect(create?.body?.region).toBe("nyc3");
    expect(create?.body?.size).toBe("s-1vcpu-1gb");
    expect(create?.body?.image).toBe("docker-20-04");
    expect(allocation.target.host).toBe("203.0.113.3");
    expect(allocation.target.username).toBe("root");
  });

  it("digitalocean: env overrides for region / size / image / ssh keys / user beat the defaults", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "digitalocean";
    process.env.TANREN_DO_API_TOKEN = "tok";
    process.env.TANREN_DO_HOST_FINGERPRINT = "SHA256:do";
    process.env.TANREN_DO_REGION = "sgp1";
    process.env.TANREN_DO_SIZE = "s-4vcpu-8gb";
    process.env.TANREN_DO_IMAGE = "ubuntu-24-04-x64";
    process.env.TANREN_DO_SSH_KEYS = "fp-1, fp-2";
    process.env.TANREN_DO_SSH_USER = "deploy";
    const droplet = {
      droplet: { id: 201, status: "active", networks: { v4: [{ ip_address: "203.0.113.31", type: "public" }] } },
    };
    const calls = stubFetch(() => json(droplet, 202));
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    const create = calls.find((c) => c.method === "POST");
    expect(create?.body?.region).toBe("sgp1");
    expect(create?.body?.size).toBe("s-4vcpu-8gb");
    expect(create?.body?.image).toBe("ubuntu-24-04-x64");
    expect(create?.body?.ssh_keys).toEqual(["fp-1", "fp-2"]);
    expect(allocation.target.username).toBe("deploy");
  });

  it("gcp: default machine type / image / tanren user from env flow into the insert call + target", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "gcp";
    process.env.TANREN_GCP_ACCESS_TOKEN = "tok";
    process.env.TANREN_GCP_PROJECT = "proj-x";
    process.env.TANREN_GCP_ZONE = "us-central1-a";
    process.env.TANREN_GCP_SSH_PUBLIC_KEY = "ssh-ed25519 AAAA";
    process.env.TANREN_GCP_HOST_FINGERPRINT = "SHA256:gcp";
    const calls = stubFetch((url) => {
      if (url.endsWith("/instances") && !url.includes("/instances/")) {
        return json({ name: "op-1", status: "DONE" }); // insert op (done immediately)
      }
      if (url.includes("/operations/")) {
        return json({ name: "op-1", status: "DONE" });
      }
      // getInstance: running with external IP.
      return json({
        name: "tanren-run-e2e",
        status: "RUNNING",
        networkInterfaces: [{ accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "203.0.113.4" }] }],
      });
    });
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);

    const insert = calls.find((c) => c.method === "POST");
    // Default machineType e2-small rendered as a zone-qualified path.
    expect(insert?.body?.machineType).toBe("zones/us-central1-a/machineTypes/e2-small");
    // Default source image is the COS stable family path, on the boot disk.
    const disks = insert?.body?.disks as Array<{ initializeParams: { sourceImage: string } }>;
    expect(disks[0]?.initializeParams.sourceImage).toBe("projects/cos-cloud/global/images/family/cos-stable");
    expect(allocation.target.host).toBe("203.0.113.4");
    // Default ssh user is tanren.
    expect(allocation.target.username).toBe("tanren");
  });

  it("gcp: env overrides for machine type / source image / ssh user beat the defaults", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "gcp";
    process.env.TANREN_GCP_ACCESS_TOKEN = "tok";
    process.env.TANREN_GCP_PROJECT = "proj-x";
    process.env.TANREN_GCP_ZONE = "us-central1-a";
    process.env.TANREN_GCP_SSH_PUBLIC_KEY = "ssh-ed25519 AAAA";
    process.env.TANREN_GCP_HOST_FINGERPRINT = "SHA256:gcp";
    process.env.TANREN_GCP_MACHINE_TYPE = "n2-standard-4";
    process.env.TANREN_GCP_IMAGE = "projects/debian-cloud/global/images/family/debian-12";
    process.env.TANREN_GCP_SSH_USER = "deploy";
    const calls = stubFetch((url) => {
      if (url.includes("/operations/")) {
        return json({ name: "op-1", status: "DONE" });
      }
      if (url.endsWith("/instances")) {
        return json({ name: "op-1", status: "DONE" });
      }
      return json({
        name: "tanren-run-e2e",
        status: "RUNNING",
        networkInterfaces: [{ accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "203.0.113.41" }] }],
      });
    });
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    const insert = calls.find((c) => c.method === "POST");
    expect(insert?.body?.machineType).toBe("zones/us-central1-a/machineTypes/n2-standard-4");
    const disks = insert?.body?.disks as Array<{ initializeParams: { sourceImage: string } }>;
    expect(disks[0]?.initializeParams.sourceImage).toBe("projects/debian-cloud/global/images/family/debian-12");
    expect(allocation.target.username).toBe("deploy");
  });

  it("kubernetes: default tanren user from env flows into the target; secret+pod are created", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "kubernetes";
    process.env.TANREN_K8S_API_SERVER = "https://k8s:6443";
    process.env.TANREN_K8S_TOKEN_REF = "tok";
    process.env.TANREN_K8S_NAMESPACE = "tanren-ns";
    process.env.TANREN_K8S_RUNNER_IMAGE = "ghcr.io/x/runner:v0";
    process.env.TANREN_K8S_SSH_PUBLIC_KEY = "ssh-ed25519 AAAA";
    process.env.TANREN_K8S_HOST_FINGERPRINT = "SHA256:k8s";
    const calls = stubFetch((url) => {
      if (url.endsWith("/secrets")) {
        return json({}, 201);
      }
      if (url.endsWith("/pods")) {
        return json({ metadata: { name: "tanren-run-e2e" }, status: { phase: "Pending" } }, 201);
      }
      // getPod: running with a pod IP.
      return json({ metadata: { name: "tanren-run-e2e" }, status: { phase: "Running", podIP: "10.2.3.4" } });
    });
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);

    expect(calls.some((c) => c.url.endsWith("/secrets") && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/pods") && c.method === "POST")).toBe(true);
    expect(allocation.target.host).toBe("10.2.3.4");
    expect(allocation.target.username).toBe("tanren");
    // The namespaced path is assembled from the env api server + namespace.
    expect(calls[0]?.url).toMatch(/^https:\/\/k8s:6443\/api\/v1\/namespaces\/tanren-ns\//u);
  });

  it("aws_ec2: default ec2-user + region endpoint from env flow into the request + target", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "aws_ec2";
    process.env.TANREN_AWS_ACCESS_KEY_ID = "AKIA";
    process.env.TANREN_AWS_SECRET_ACCESS_KEY = "secret";
    process.env.TANREN_AWS_REGION = "eu-central-1";
    process.env.TANREN_AWS_IMAGE_ID = "ami-123";
    process.env.TANREN_AWS_HOST_FINGERPRINT = "SHA256:aws";
    const runningXml =
      `<DescribeInstancesResponse><reservationSet><item><instancesSet><item>` +
      `<instanceId>i-e2e</instanceId><instanceState><name>running</name></instanceState>` +
      `<ipAddress>203.0.113.5</ipAddress></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`;
    const pendingXml =
      `<RunInstancesResponse><instancesSet><item><instanceId>i-e2e</instanceId>` +
      `<instanceState><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`;
    const calls: CapturedCall[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, method: init?.method });
      const xml = url.includes("RunInstances") ? pendingXml : runningXml;
      return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
    }) as typeof fetch;

    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    // The region-derived endpoint host comes from the env region.
    expect(calls[0]?.url).toMatch(/^https:\/\/ec2\.eu-central-1\.amazonaws\.com\//u);
    expect(allocation.target.host).toBe("203.0.113.5");
    // Default ssh user is ec2-user.
    expect(allocation.target.username).toBe("ec2-user");
  });

  it("aws_ec2: env overrides for instance type / key / subnet / sec groups / user-data / token flow into the request", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "aws_ec2";
    process.env.TANREN_AWS_ACCESS_KEY_ID = "AKIA";
    process.env.TANREN_AWS_SECRET_ACCESS_KEY = "secret";
    process.env.TANREN_AWS_REGION = "us-east-1";
    process.env.TANREN_AWS_IMAGE_ID = "ami-999";
    process.env.TANREN_AWS_HOST_FINGERPRINT = "SHA256:aws";
    process.env.TANREN_AWS_INSTANCE_TYPE = "m6i.large";
    process.env.TANREN_AWS_KEY_NAME = "tanren-kp";
    process.env.TANREN_AWS_SUBNET_ID = "subnet-abc";
    process.env.TANREN_AWS_SECURITY_GROUP_IDS = "sg-1, sg-2";
    process.env.TANREN_AWS_USER_DATA = "Y2xvdWQtaW5pdA==";
    process.env.TANREN_AWS_SESSION_TOKEN = "sess-tok";
    process.env.TANREN_AWS_SSH_USER = "ubuntu";
    const runInUrls: string[] = [];
    let sawSecurityHeader = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.headers as Record<string, string> | undefined)?.["x-amz-security-token"] === "sess-tok") {
        sawSecurityHeader = true;
      }
      if (url.includes("RunInstances")) {
        runInUrls.push(url);
        return new Response(
          `<RunInstancesResponse><instancesSet><item><instanceId>i-o</instanceId>` +
            `<instanceState><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        );
      }
      return new Response(
        `<DescribeInstancesResponse><reservationSet><item><instancesSet><item>` +
          `<instanceId>i-o</instanceId><instanceState><name>running</name></instanceState>` +
          `<ipAddress>203.0.113.6</ipAddress></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`,
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }) as typeof fetch;

    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    const runUrl = runInUrls[0] ?? "";
    expect(runUrl).toMatch(/InstanceType=m6i.large/u);
    expect(runUrl).toMatch(/KeyName=tanren-kp/u);
    expect(runUrl).toMatch(/SubnetId=subnet-abc/u);
    expect(runUrl).toMatch(/SecurityGroupId\.1=sg-1/u);
    expect(runUrl).toMatch(/SecurityGroupId\.2=sg-2/u);
    expect(runUrl).toMatch(/UserData=/u);
    // The session token rides as a signed query param + a header.
    expect(runUrl).toMatch(/X-Amz-Security-Token=sess-tok/u);
    expect(sawSecurityHeader).toBe(true);
    expect(allocation.target.username).toBe("ubuntu");
  });

  it("sidecar: default base url + token from env drive the /allocate call", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "sidecar";
    let captured: { url: string; auth?: string } = { url: "" };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      };
      return json({
        runnerId: "runner_sc",
        sshHost: "h",
        sshPort: 22,
        hostKeyFingerprint: "SHA256:y",
        imageSha: "sha256:z",
      });
    }) as typeof fetch;
    await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    // Defaults from buildSidecar: base url http://allocator:3200, token "dev".
    expect(captured.url).toBe("http://allocator:3200/allocate");
    expect(captured.auth).toBe("Bearer dev");
  });

  it("sidecar: env overrides for the allocator url + token beat the defaults", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "sidecar";
    process.env.TANREN_ALLOCATOR_URL = "http://sidecar.internal:9000";
    process.env.TANREN_ALLOCATOR_TOKEN = "prod-token";
    let captured: { url: string; auth?: string } = { url: "" };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      };
      return json({
        runnerId: "runner_sc2",
        sshHost: "h",
        sshPort: 22,
        hostKeyFingerprint: "SHA256:y",
        imageSha: "sha256:z",
      });
    }) as typeof fetch;
    await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(captured.url).toBe("http://sidecar.internal:9000/allocate");
    expect(captured.auth).toBe("Bearer prod-token");
  });

  it("static: default host / port / user defaults from env are returned in the target", async () => {
    // static uses a pre-known fingerprint (no TOFU) so no SSH handshake runs.
    process.env.TANREN_ALLOCATOR_KIND = "static";
    process.env.TANREN_RUNNER_SSH_HOST_FINGERPRINT = "SHA256:static-pin";
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    // Defaults from buildStatic: host "runner", port 22, user "tanren".
    expect(allocation.target.host).toBe("runner");
    expect(allocation.target.port).toBe(22);
    expect(allocation.target.username).toBe("tanren");
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:static-pin");
  });

  it("static: env overrides for host / port / user beat the defaults", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "static";
    process.env.TANREN_RUNNER_SSH_HOST = "10.20.30.40";
    process.env.TANREN_RUNNER_SSH_PORT = "2200";
    process.env.TANREN_RUNNER_SSH_USER = "runner-user";
    process.env.TANREN_RUNNER_SSH_HOST_FINGERPRINT = "SHA256:static-pin";
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(allocation.target.host).toBe("10.20.30.40");
    expect(allocation.target.port).toBe(2200);
    expect(allocation.target.username).toBe("runner-user");
  });

  it("manual_ssh: the configured host pool from env JSON is returned in the target", async () => {
    process.env.TANREN_ALLOCATOR_KIND = "manual_ssh";
    process.env.TANREN_MANUAL_SSH_HOSTS = JSON.stringify([
      { id: "h1", host: "10.9.8.7", port: 2022, username: "ops", hostKeyFingerprint: "SHA256:m" },
    ]);
    const allocation = await buildAllocatorFromEnv(queryPool).allocate(allocReq);
    expect(allocation.target.host).toBe("10.9.8.7");
    expect(allocation.target.port).toBe(2022);
    expect(allocation.target.username).toBe("ops");
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:m");
  });
});
