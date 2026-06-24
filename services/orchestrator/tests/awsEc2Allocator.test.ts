import { describe, expect, it } from "vitest";
import {
  AwsEc2Allocator,
  AwsEc2AllocatorError,
  fetchAwsEc2Client,
  type AwsEc2Client,
  type AwsEc2Instance,
  type AwsRunInstancesInput,
} from "../src/engine/allocators/awsEc2Allocator.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
} from "../src/engine/allocators/readinessConvergence.js";
import type { Allocator } from "../src/engine/contracts/allocator.js";
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";
import { describeReadinessConvergence } from "./conformance/readinessConvergenceConformance.js";

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
  constructor(
    private readonly opts: {
      neverRunning?: boolean;
      noIp?: boolean;
      emptyIp?: boolean;
      terminal?: boolean;
      terminalState?: string;
      /** Pin a brand-new unrecognized state string the allowlist doesn't know. */
      unknownState?: string;
    } = {},
  ) {}

  async runInstances(input: AwsRunInstancesInput): Promise<AwsEc2Instance> {
    this.run.push(input);
    this.instanceCounter += 1;
    return { instanceId: `i-${this.instanceCounter}`, state: "pending" };
  }
  async describeInstance(instanceId: string): Promise<AwsEc2Instance> {
    this.getCalls += 1;
    if (this.opts.unknownState !== undefined) {
      return { instanceId, state: this.opts.unknownState };
    }
    if (this.opts.terminal) {
      return { instanceId, state: this.opts.terminalState ?? "terminated" };
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
      publicIp: this.opts.noIp ? undefined : this.opts.emptyIp ? "" : "203.0.113.7",
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
  sleep: async () => {},
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

  it("defaults the SSH username to ec2-user when none is configured", async () => {
    const client = new FakeAwsEc2Client();
    const { sshUsername: _omit, ...rest } = baseOpts(client, new FakeRunnerStore());
    const allocation = await new AwsEc2Allocator(rest).allocate(req("run_def"));
    expect(allocation.target.username).toBe("ec2-user");
  });

  it("honors an explicit SSH username override", async () => {
    const client = new FakeAwsEc2Client();
    const allocation = await new AwsEc2Allocator({
      ...baseOpts(client, new FakeRunnerStore()),
      sshUsername: "admin",
    }).allocate(req("run_ov"));
    expect(allocation.target.username).toBe("admin");
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

  // Task #31: the wait now polls on STRUCTURAL signature progress (no wall-clock
  // deadline). An instance stuck at `pending|no-ip` returns the SAME signature every
  // probe, so the loop crosses the saturation gate and surfaces
  // `PersistentProvisioningOutageError` LOUD (wrapped in the per-allocator typed
  // error with `cause` preserved so the inner stuck-signature is accessible).
  it("surfaces a typed error and terminates on a stuck-signature fixed point (instance never runs)", async () => {
    const client = new FakeAwsEc2Client({ neverRunning: true });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    let caught: unknown;
    try {
      await allocator.allocate(req("run_3"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AwsEc2AllocatorError);
    expect((caught as Error).message).toMatch(/did not become running/u);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
    expect(((caught as { cause: PersistentProvisioningOutageError }).cause).stuckSignature).toBe("pending|no-ip");
    expect(client.terminated).toContain("i-1");
  });

  it("surfaces a typed error and terminates if the instance hits a terminal state", async () => {
    const client = new FakeAwsEc2Client({ terminal: true });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator(baseOpts(client, runners));
    await expect(allocator.allocate(req("run_t"))).rejects.toBeInstanceOf(AwsEc2AllocatorError);
    expect(client.terminated).toContain("i-1");
  });

  it("surfaces a typed error and terminates on a stuck-signature fixed point (no public IP)", async () => {
    const client = new FakeAwsEc2Client({ noIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    let caught: unknown;
    try {
      await allocator.allocate(req("run_4"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AwsEc2AllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
    expect(client.terminated).toContain("i-1");
  });

  it("requires credentials and a pinned fingerprint", () => {
    const runners = new FakeRunnerStore();
    expect(() => new AwsEc2Allocator({ ...baseOpts(new FakeAwsEc2Client(), runners), accessKeyId: "" })).toThrow(
      /non-empty AWS credentials/u,
    );
    expect(() => new AwsEc2Allocator({ ...baseOpts(new FakeAwsEc2Client(), runners), secretAccessKey: "" })).toThrow(
      /non-empty AWS credentials/u,
    );
    expect(
      () =>
        new AwsEc2Allocator({
          ...baseOpts(new FakeAwsEc2Client(), runners),
          hostKeyFingerprint: "",
        }),
    ).toThrow(/pinned hostKeyFingerprint/u);
  });

  it("terminates the instance if the runner store claim fails", async () => {
    const client = new FakeAwsEc2Client();
    const runners = new FakeRunnerStore();
    runners.claim = async () => {
      throw new Error("claim conflict");
    };
    const allocator = new AwsEc2Allocator(baseOpts(client, runners));
    await expect(allocator.allocate(req("run_c"))).rejects.toThrow(/claim conflict/u);
    expect(client.terminated).toContain("i-1");
  });

  // waitForRunning requires `running` AND a non-empty public IP. An empty-string
  // IP must NOT satisfy the ready condition: a mutant dropping the `ip === ""`
  // arm would return immediately with a bogus empty host. Here the empty IP
  // keeps the wait polling and ultimately surfaces the stuck-signature fixed
  // point (`running|no-ip`), and the instance is terminated.
  it("treats an empty-string public IP as not-yet-ready and terminates on stuck-signature fixed point", async () => {
    const client = new FakeAwsEc2Client({ emptyIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    await expect(allocator.allocate(req("run_empty"))).rejects.toThrow(/did not become running/u);
    expect(client.terminated).toContain("i-1");
    expect(runners.claims).toEqual([]);
  });

  // waitForRunning treats BOTH "terminated" and "shutting-down" as terminal.
  // The terminal-state test above only exercises "terminated"; pin
  // "shutting-down" so the second arm of the `||` cannot be dropped, and assert
  // the error message names the actual terminal state it observed.
  it("fails fast with the observed terminal state when the instance is shutting-down", async () => {
    const client = new FakeAwsEc2Client({ terminal: true, terminalState: "shutting-down" });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator(baseOpts(client, runners));
    await expect(allocator.allocate(req("run_sd"))).rejects.toThrow(/terminal state 'shutting-down'/u);
    expect(client.terminated).toContain("i-1");
  });

  // The error subclass sets a distinct `.name`; a mutant blanking the name
  // string survives a bare `instanceof` check. Pin the name explicitly.
  it("AwsEc2AllocatorError carries the AwsEc2AllocatorError name", () => {
    const error = new AwsEc2AllocatorError("boom");
    expect(error.name).toBe("AwsEc2AllocatorError");
    expect(error).toBeInstanceOf(Error);
  });

  // The instance Name tag is the run id sanitized to lowercase + hyphens. Pin
  // the exact sanitized value so the toLowerCase / replace-regex mutants on
  // that template are caught (the raw run id is preserved on the tanren-run tag
  // for traceability, so both transformed + raw forms are asserted).
  it("sanitizes the run id into the instance Name tag while preserving the raw tanren-run tag", async () => {
    const client = new FakeAwsEc2Client();
    const allocator = new AwsEc2Allocator(baseOpts(client, new FakeRunnerStore()));
    await allocator.allocate(req("Run_ABC/9"));
    expect(client.run[0]?.tags?.Name).toBe("tanren-run-abc-9");
    expect(client.run[0]?.tags?.["tanren-run"]).toBe("Run_ABC/9");
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
    expect(captured.url).toMatch(/^https:\/\/ec2\.us-east-1\.amazonaws\.com\/\?/u);
    expect(captured.url).toMatch(/Action=DescribeInstances/u);
    expect(captured.method).toBe("GET");
    expect(captured.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/ec2\/aws4_request/u);
    expect(captured.auth).toMatch(/SignedHeaders=host;x-amz-date/u);
    expect(captured.auth).toMatch(/Signature=[0-9a-f]{64}/u);
    expect(captured.date).toMatch(/^\d{8}T\d{6}Z$/u);
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
    expect(url).toMatch(/Action=RunInstances/u);
    expect(url).toMatch(/ImageId=ami-1/u);
    expect(url).toMatch(/InstanceType=t3.micro/u);
    // MinCount/MaxCount are fixed at 1 each (single runner per allocation).
    expect(url).toMatch(/MinCount=1/u);
    expect(url).toMatch(/MaxCount=1/u);
    // Optional params present in the input must appear in the query...
    expect(url).toMatch(/KeyName=kp/u);
    expect(url).toMatch(/SecurityGroupId\.1=sg-9/u);
    expect(url).toMatch(/TagSpecification\.1\.ResourceType=instance/u);
    expect(url).toMatch(/TagSpecification\.1\.Tag\.1\.Key=Name/u);
    expect(url).toMatch(/TagSpecification\.1\.Tag\.1\.Value=tanren-x/u);
    // ...and ones that were not supplied must be absent.
    expect(url).not.toMatch(/SubnetId=/u);
    expect(url).not.toMatch(/UserData=/u);
    expect(url).not.toMatch(/SecurityGroupId\.2=/u);
    expect(instance).toEqual({ instanceId: "i-new", state: "pending", publicIp: undefined });
  });

  it("omits optional RunInstances params when they are not supplied", async () => {
    let url = "";
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      url = typeof input === "string" ? input : input.toString();
      return new Response(
        `<RunInstancesResponse><instancesSet><item><instanceId>i-min</instanceId>` +
          `<instanceState><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`,
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }) as typeof fetch;
    const client = fetchAwsEc2Client({ accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" }, fetchImpl);
    await client.runInstances({ imageId: "ami-1", instanceType: "t3.micro" });
    expect(url).not.toMatch(/KeyName=/u);
    expect(url).not.toMatch(/SubnetId=/u);
    expect(url).not.toMatch(/SecurityGroupId\./u);
    expect(url).not.toMatch(/UserData=/u);
    expect(url).not.toMatch(/TagSpecification/u);
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

  // The optional `subnetId` / `userData` params are conditionally appended to
  // the signed query. A mutant that flips those `!== undefined` guards (or
  // empties the param name) drops the value from the request; assert both land
  // in the query verbatim when supplied.
  it("includes subnetId and userData in the signed query when supplied", async () => {
    let url = "";
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      url = typeof input === "string" ? input : input.toString();
      return new Response(
        `<RunInstancesResponse><instancesSet><item><instanceId>i-z</instanceId>` +
          `<instanceState><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`,
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }) as typeof fetch;
    const client = fetchAwsEc2Client({ accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" }, fetchImpl);
    await client.runInstances({
      imageId: "ami-1",
      instanceType: "t3.micro",
      subnetId: "subnet-xyz",
      userData: "cloud-init-blob",
    });
    expect(url).toMatch(/SubnetId=subnet-xyz/u);
    expect(url).toMatch(/UserData=cloud-init-blob/u);
  });

  // A temporary-credential session token is sent BOTH as the `X-Amz-Security-Token`
  // query param (so it is covered by the signature) AND the `x-amz-security-token`
  // header. The existing test only checks the header; pin the query param too so
  // the param-injection guard cannot be dropped, and confirm it is absent when no
  // token is configured.
  it("adds the session token as a signed query param and a header, and omits both without one", async () => {
    let withTokenUrl = "";
    let withTokenHeader: string | undefined;
    const withTokenFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      withTokenUrl = typeof input === "string" ? input : input.toString();
      withTokenHeader = (init?.headers as Record<string, string> | undefined)?.["x-amz-security-token"];
      return new Response(runningXml, { status: 200, headers: { "Content-Type": "text/xml" } });
    }) as typeof fetch;
    await fetchAwsEc2Client(
      { accessKeyId: "k", secretAccessKey: "s", region: "us-east-1", sessionToken: "sess-789" },
      withTokenFetch,
    ).describeInstance("i-abc123");
    expect(withTokenUrl).toMatch(/X-Amz-Security-Token=sess-789/u);
    expect(withTokenHeader).toBe("sess-789");

    let plainUrl = "";
    let plainHeader: string | undefined = "set";
    const plainFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      plainUrl = typeof input === "string" ? input : input.toString();
      plainHeader = (init?.headers as Record<string, string> | undefined)?.["x-amz-security-token"];
      return new Response(runningXml, { status: 200, headers: { "Content-Type": "text/xml" } });
    }) as typeof fetch;
    await fetchAwsEc2Client(
      { accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" },
      plainFetch,
    ).describeInstance("i-abc123");
    expect(plainUrl).not.toMatch(/X-Amz-Security-Token=/u);
    expect(plainHeader).toBeUndefined();
  });

  // The endpoint host is region-derived (`ec2.<region>.amazonaws.com`) and the
  // request carries the pinned API Version. A mutant changing the host template
  // or the version literal would mis-route / mis-version the call.
  it("targets the region endpoint and sends the pinned EC2 API version", async () => {
    let url = "";
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      url = typeof input === "string" ? input : input.toString();
      return new Response(runningXml, { status: 200, headers: { "Content-Type": "text/xml" } });
    }) as typeof fetch;
    await fetchAwsEc2Client(
      { accessKeyId: "k", secretAccessKey: "s", region: "ap-southeast-2" },
      fetchImpl,
    ).describeInstance("i-abc123");
    expect(url).toMatch(/^https:\/\/ec2\.ap-southeast-2\.amazonaws\.com\//u);
    expect(url).toMatch(/Version=2016-11-15/u);
  });
});

// Task #31: shared readiness-convergence conformance suite. Pins the 4 scenarios
// (advancing-unbounded / stuck-fixed-point / unknown-state / terminal-arms) at
// the per-allocator wiring. EC2's documented terminal arms (`terminated`,
// `shutting-down`, `stopping`, `stopped`) each fire `ProvisioningTerminalStateError`
// IMMEDIATELY; the conformance suite holds every one to the same contract.

/** Each probe yields a NEW structural signature → loop runs unbounded → ready hit. */
class AdvancingFakeAwsEc2Client implements AwsEc2Client {
  private getCalls = 0;
  async runInstances(): Promise<AwsEc2Instance> {
    return { instanceId: "i-1", state: "pending" };
  }
  async describeInstance(instanceId: string): Promise<AwsEc2Instance> {
    this.getCalls += 1;
    if (this.getCalls >= 8) {
      return { instanceId, state: "running", publicIp: "203.0.113.7" };
    }
    // Alternate IP / no-IP under `pending` / `running` so each probe's signature
    // is distinct (advancing forward, never identical neighbors).
    const state = this.getCalls < 4 ? "pending" : "running";
    const publicIp = this.getCalls % 2 === 0 ? undefined : `intermediate-${this.getCalls}`;
    return { instanceId, state, publicIp };
  }
  async terminateInstance(): Promise<void> {}
}

const awsHarness = {
  buildAdvancing() {
    const client = new AdvancingFakeAwsEc2Client();
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_adv"), expectedAdvancingProbes: 7 };
  },
  buildStuck() {
    const client = new FakeAwsEc2Client({ neverRunning: true });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_stuck"), expectedStuckSignature: "pending|no-ip" };
  },
  buildUnknownState() {
    const client = new FakeAwsEc2Client({ unknownState: "hibernating-saving-state" });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_unk"), expectedUnknownState: "hibernating-saving-state" };
  },
  buildTerminalArm(terminalState: string) {
    const client = new FakeAwsEc2Client({ terminal: true, terminalState });
    const runners = new FakeRunnerStore();
    const allocator = new AwsEc2Allocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_term") };
  },
  // EC2's `AWS_EC2_TERMINAL_STATES` allowlist — each fires the terminal arm IMMEDIATELY.
  expectedTerminalArms: ["terminated", "shutting-down", "stopping", "stopped"] as const,
};

describe("AwsEc2Allocator — readiness convergence inner contract", () => {
  it("wraps PersistentProvisioningOutageError as AwsEc2AllocatorError with cause", async () => {
    const { allocator, request } = awsHarness.buildStuck();
    let caught: unknown;
    try {
      await allocator.allocate(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AwsEc2AllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
  });

  it("wraps UnknownProvisioningStateError as AwsEc2AllocatorError with cause", async () => {
    const { allocator, request } = awsHarness.buildUnknownState();
    let caught: unknown;
    try {
      await allocator.allocate(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AwsEc2AllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(UnknownProvisioningStateError);
  });

  it("wraps ProvisioningTerminalStateError as AwsEc2AllocatorError with cause", async () => {
    const { allocator, request } = awsHarness.buildTerminalArm("terminated");
    let caught: unknown;
    try {
      await allocator.allocate(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AwsEc2AllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ProvisioningTerminalStateError);
  });
});

function unwrapAwsEc2(allocator: Allocator): Allocator {
  return {
    async allocate(request) {
      try {
        return await allocator.allocate(request);
      } catch (error) {
        if (error instanceof AwsEc2AllocatorError && error.cause !== undefined) {
          throw error.cause;
        }
        throw error;
      }
    },
    release: allocator.release.bind(allocator),
  };
}

describeReadinessConvergence("AwsEc2", {
  buildAdvancing: () => {
    const inner = awsHarness.buildAdvancing();
    return { ...inner, allocator: unwrapAwsEc2(inner.allocator) };
  },
  buildStuck: () => {
    const inner = awsHarness.buildStuck();
    return { ...inner, allocator: unwrapAwsEc2(inner.allocator) };
  },
  buildUnknownState: () => {
    const inner = awsHarness.buildUnknownState();
    return { ...inner, allocator: unwrapAwsEc2(inner.allocator) };
  },
  buildTerminalArm: (terminalState) => {
    const inner = awsHarness.buildTerminalArm(terminalState);
    return { ...inner, allocator: unwrapAwsEc2(inner.allocator) };
  },
  expectedTerminalArms: awsHarness.expectedTerminalArms,
});
