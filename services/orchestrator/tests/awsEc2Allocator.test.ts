import { describe, expect, it } from "vitest";
import {
  AwsEc2Allocator,
  AwsEc2AllocatorError,
  fetchAwsEc2Client,
  type AwsEc2Client,
  type AwsEc2Instance,
  type AwsRunInstancesInput,
} from "../src/engine/allocators/awsEc2Allocator.js";
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";

class FakeRunnerStore implements RunnerStore {
  readonly claims: ClaimRunnerInput[] = [];
  readonly releases: string[] = [];
  async claim(input: ClaimRunnerInput): Promise<void> {
    this.claims.push(input);
  }
  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
  }
}

/**
 * Mocked EC2 API: runInstances returns a `pending` instance; describeInstance
 * is `pending` then `running` with a public IP.
 */
class FakeAwsEc2Client implements AwsEc2Client {
  readonly run: AwsRunInstancesInput[] = [];
  readonly terminated: string[] = [];
  private getCalls = 0;
  private instanceCounter = 0;
  constructor(private readonly opts: { neverRunning?: boolean; noIp?: boolean; terminal?: boolean } = {}) {}

  async runInstances(input: AwsRunInstancesInput): Promise<AwsEc2Instance> {
    this.run.push(input);
    this.instanceCounter += 1;
    return { instanceId: `i-${this.instanceCounter}`, state: "pending" };
  }
  async describeInstance(instanceId: string): Promise<AwsEc2Instance> {
    this.getCalls += 1;
    if (this.opts.terminal) {
      return { instanceId, state: "terminated" };
    }
    if (this.opts.neverRunning) {
      return { instanceId, state: "pending" };
    }
    if (this.getCalls < 2) {
      return { instanceId, state: "pending" };
    }
    return {
      instanceId,
      state: "running",
      publicIp: this.opts.noIp ? undefined : "203.0.113.7",
    };
  }
  async terminateInstance(instanceId: string): Promise<void> {
    this.terminated.push(instanceId);
  }
}

const baseOpts = (client: AwsEc2Client, runners: RunnerStore) => ({
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
  region: "us-east-1",
  imageId: "ami-0abcd1234",
  instanceType: "t3.small",
  keyName: "tanren-runner",
  subnetId: "subnet-123",
  securityGroupIds: ["sg-123"],
  sshUsername: "ec2-user",
  hostKeyFingerprint: "SHA256:aws",
  runners,
  client,
  sleep: async () => undefined,
});

function req(runId: string) {
  return {
    runId,
    projectId: "proj_aws",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

describe("AwsEc2Allocator", () => {
  it("runs an instance, waits until running + IP, and returns the SSH target", async () => {
    const client = new FakeAwsEc2Client();
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator(baseOpts(client, runners));

    const allocation = await allocator.allocate(req("run_1"));
    expect(client.run).toHaveLength(1);
    expect(client.run[0]?.imageId).toBe("ami-0abcd1234");
    expect(client.run[0]?.instanceType).toBe("t3.small");
    expect(client.run[0]?.keyName).toBe("tanren-runner");
    expect(client.run[0]?.securityGroupIds).toEqual(["sg-123"]);
    expect(client.run[0]?.tags?.["tanren-run"]).toBe("run_1");
    expect(allocation.target.host).toBe("203.0.113.7");
    expect(allocation.target.port).toBe(22);
    expect(allocation.target.username).toBe("ec2-user");
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:aws");
    expect(runners.claims[0]?.allocator).toBe("aws_ec2");
    expect(runners.claims[0]?.containerId).toBe("i-1");
  });

  it("terminates the instance and clears the mirror row on release", async () => {
    const client = new FakeAwsEc2Client();
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator(baseOpts(client, runners));
    const allocation = await allocator.allocate(req("run_2"));
    await allocator.release(allocation.runnerId, "completed");
    expect(client.terminated).toEqual(["i-1"]);
    expect(runners.releases).toEqual([allocation.runnerId]);
  });

  it("release is idempotent: releasing twice terminates only once", async () => {
    const client = new FakeAwsEc2Client();
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator(baseOpts(client, runners));
    const allocation = await allocator.allocate(req("run_2b"));
    await allocator.release(allocation.runnerId);
    await allocator.release(allocation.runnerId);
    expect(client.terminated).toEqual(["i-1"]);
  });

  it("release of an unknown runner is a no-op", async () => {
    const client = new FakeAwsEc2Client();
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator(baseOpts(client, runners));
    await allocator.release("runner_unknown");
    expect(client.terminated).toEqual([]);
  });

  it("surfaces a typed error and terminates if the instance never runs", async () => {
    const client = new FakeAwsEc2Client({ neverRunning: true });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(allocator.allocate(req("run_3"))).rejects.toThrow(/did not become running/);
    expect(client.terminated).toContain("i-1");
  });

  it("surfaces a typed error and terminates if the instance hits a terminal state", async () => {
    const client = new FakeAwsEc2Client({ terminal: true });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator(baseOpts(client, runners));
    await expect(allocator.allocate(req("run_t"))).rejects.toBeInstanceOf(AwsEc2AllocatorError);
    expect(client.terminated).toContain("i-1");
  });

  it("surfaces a typed error and terminates if it has no public IP", async () => {
    const client = new FakeAwsEc2Client({ noIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(allocator.allocate(req("run_4"))).rejects.toBeInstanceOf(AwsEc2AllocatorError);
    expect(client.terminated).toContain("i-1");
  });

  it("requires credentials and a pinned fingerprint", () => {
    const runners = new FakeRunnerStore();
    expect(() => new AwsEc2Allocator({ ...baseOpts(new FakeAwsEc2Client(), runners), accessKeyId: "" })).toThrow(
      /non-empty AWS credentials/,
    );
    expect(() => new AwsEc2Allocator({ ...baseOpts(new FakeAwsEc2Client(), runners), secretAccessKey: "" })).toThrow(
      /non-empty AWS credentials/,
    );
    expect(
      () =>
        new AwsEc2Allocator({
          ...baseOpts(new FakeAwsEc2Client(), runners),
          hostKeyFingerprint: "",
        }),
    ).toThrow(/pinned hostKeyFingerprint/);
  });

  it("terminates the instance if the runner store claim fails", async () => {
    const client = new FakeAwsEc2Client();
    const runners = new FakeRunnerStore();
    runners.claim = async () => {
      throw new Error("claim conflict");
    };
    const allocator = new AwsEc2Allocator(baseOpts(client, runners));
    await expect(allocator.allocate(req("run_c"))).rejects.toThrow(/claim conflict/);
    expect(client.terminated).toContain("i-1");
  });
});

describe("fetchAwsEc2Client", () => {
  const runningXml = `<?xml version="1.0"?>
    <DescribeInstancesResponse>
      <reservationSet><item><instancesSet><item>
        <instanceId>i-abc123</instanceId>
        <instanceState><code>16</code><name>running</name></instanceState>
        <ipAddress>198.51.100.9</ipAddress>
      </item></instancesSet></item></reservationSet>
    </DescribeInstancesResponse>`;

  it("signs the request with SigV4 and maps the running instance response", async () => {
    let captured: { url: string; method?: string; auth?: string; date?: string } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = init?.headers as Record<string, string> | undefined;
      captured = {
        url,
        method: init?.method,
        auth: headers?.authorization,
        date: headers?.["x-amz-date"],
      };
      return new Response(runningXml, { status: 200, headers: { "Content-Type": "text/xml" } });
    }) as typeof fetch;

    const client = fetchAwsEc2Client(
      { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-east-1" },
      fetchImpl,
    );
    const instance = await client.describeInstance("i-abc123");
    expect(captured.url).toMatch(/^https:\/\/ec2\.us-east-1\.amazonaws\.com\/\?/);
    expect(captured.url).toMatch(/Action=DescribeInstances/);
    expect(captured.method).toBe("GET");
    expect(captured.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/ec2\/aws4_request/);
    expect(captured.auth).toMatch(/SignedHeaders=host;x-amz-date/);
    expect(captured.auth).toMatch(/Signature=[0-9a-f]{64}/);
    expect(captured.date).toMatch(/^\d{8}T\d{6}Z$/);
    expect(instance).toEqual({
      instanceId: "i-abc123",
      state: "running",
      publicIp: "198.51.100.9",
    });
  });

  it("sends RunInstances with the launch params and parses the new instance id", async () => {
    let url = "";
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      url = typeof input === "string" ? input : input.toString();
      return new Response(
        `<RunInstancesResponse><instancesSet><item><instanceId>i-new</instanceId>` +
          `<instanceState><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`,
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }) as typeof fetch;
    const client = fetchAwsEc2Client({ accessKeyId: "k", secretAccessKey: "s", region: "eu-west-1" }, fetchImpl);
    const instance = await client.runInstances({
      imageId: "ami-1",
      instanceType: "t3.micro",
      keyName: "kp",
      securityGroupIds: ["sg-9"],
      tags: { Name: "tanren-x" },
    });
    expect(url).toMatch(/Action=RunInstances/);
    expect(url).toMatch(/ImageId=ami-1/);
    expect(url).toMatch(/InstanceType=t3.micro/);
    expect(instance).toEqual({ instanceId: "i-new", state: "pending", publicIp: undefined });
  });

  it("includes the session token header when temporary credentials are used", async () => {
    let tokenHeader: string | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      tokenHeader = (init?.headers as Record<string, string> | undefined)?.["x-amz-security-token"];
      return new Response(runningXml, { status: 200, headers: { "Content-Type": "text/xml" } });
    }) as typeof fetch;
    const client = fetchAwsEc2Client(
      { accessKeyId: "k", secretAccessKey: "s", region: "us-east-1", sessionToken: "tok-123" },
      fetchImpl,
    );
    await client.describeInstance("i-abc123");
    expect(tokenHeader).toBe("tok-123");
  });

  it("treats InvalidInstanceID.NotFound on terminate as success (idempotent)", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(`<Response><Errors><Error><Code>InvalidInstanceID.NotFound</Code></Error></Errors></Response>`, {
        status: 400,
      })) as typeof fetch;
    const client = fetchAwsEc2Client({ accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" }, fetchImpl);
    await expect(client.terminateInstance("i-gone")).resolves.toBeUndefined();
  });

  it("throws a typed error on a non-NotFound terminate failure", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("boom", { status: 500 })) as typeof fetch;
    const client = fetchAwsEc2Client({ accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" }, fetchImpl);
    await expect(client.terminateInstance("i-1")).rejects.toBeInstanceOf(AwsEc2AllocatorError);
  });

  it("throws a typed error when the response is missing an instanceId", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(`<DescribeInstancesResponse></DescribeInstancesResponse>`, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      })) as typeof fetch;
    const client = fetchAwsEc2Client({ accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" }, fetchImpl);
    await expect(client.describeInstance("i-1")).rejects.toBeInstanceOf(AwsEc2AllocatorError);
  });
});
