// Production {@link AwsEc2Client} backed by `fetch` against the EC2 query API,
// signed with AWS Signature V4 — extracted from `awsEc2Allocator.ts` to keep
// that file under the 500-line cap. A thin signed client is used instead of
// `@aws-sdk/client-ec2` to keep the allocator small, dependency-free, and
// injectable/mockable like the DO/GCP allocators.

import { createHash, createHmac } from "node:crypto";
import type { AwsEc2AllocatorOptions } from "./awsEc2Allocator.js";
import {
  AwsEc2AllocatorError,
  type AwsEc2Client,
  type AwsEc2Instance,
  type AwsRunInstancesInput,
} from "./awsEc2Shared.js";

const ec2ApiVersion = "2016-11-15";

// --- response mapping --------------------------------------------------------

/** Pulls the first capture of `tag` out of EC2's XML response, if present. */
function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, "u").exec(xml);
  return match?.[1];
}

/** Maps a `RunInstances` / `DescribeInstances` XML body to our instance shape. */
function toInstance(xml: string): AwsEc2Instance {
  const instanceId = xmlValue(xml, "instanceId");
  if (instanceId === undefined || instanceId === "") {
    throw new AwsEc2AllocatorError(`aws ec2 response missing instanceId: ${xml.slice(0, 200)}`);
  }
  // EC2 nests the state name as <instanceState>...<name>running</name>...
  const state = xmlValue(xml, "name") ?? "unknown";
  const publicIp = xmlValue(xml, "ipAddress");
  return { instanceId, state, publicIp };
}

// --- SigV4 query signing -----------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function signingKey(secretKey: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** RFC-3986 encode for canonical query strings (encodeURIComponent + extras). */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/gu,
    (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(params[key] ?? "")}`)
    .join("&");
}

interface SigV4Context {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  host: string;
  amzDate: string;
  dateStamp: string;
}

/** Builds the SigV4 `Authorization` header value for a signed GET query. */
function authorizationHeader(ctx: SigV4Context, query: string): string {
  const service = "ec2";
  const canonicalHeaders = `host:${ctx.host}\nx-amz-date:${ctx.amzDate}\n`;
  const signedHeaders = "host;x-amz-date";
  const canonicalRequest = ["GET", "/", query, canonicalHeaders, signedHeaders, sha256Hex("")].join("\n");
  const scope = `${ctx.dateStamp}/${ctx.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", ctx.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = signingKey(ctx.secretAccessKey, ctx.dateStamp, ctx.region, service);
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  return (
    `AWS4-HMAC-SHA256 Credential=${ctx.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

// --- query parameter builders ----------------------------------------------

function runInstancesParams(input: AwsRunInstancesInput): Record<string, string> {
  const params: Record<string, string> = {
    Action: "RunInstances",
    ImageId: input.imageId,
    InstanceType: input.instanceType,
    MinCount: "1",
    MaxCount: "1",
  };
  if (input.keyName !== undefined) {
    params["KeyName"] = input.keyName;
  }
  if (input.subnetId !== undefined) {
    params["SubnetId"] = input.subnetId;
  }
  (input.securityGroupIds ?? []).forEach((id, index) => {
    params[`SecurityGroupId.${index + 1}`] = id;
  });
  if (input.userData !== undefined) {
    params["UserData"] = input.userData;
  }
  Object.entries(input.tags ?? {}).forEach(([k, v], index) => {
    params["TagSpecification.1.ResourceType"] = "instance";
    params[`TagSpecification.1.Tag.${index + 1}.Key`] = k;
    params[`TagSpecification.1.Tag.${index + 1}.Value`] = v;
  });
  return params;
}

// --- production client -------------------------------------------------------

/**
 * Production {@link AwsEc2Client} backed by `fetch` against the EC2 query API,
 * signed with AWS Signature V4. Credentials are supplied by the caller
 * (resolved from Vault), never read from the environment here.
 */
export function fetchAwsEc2Client(
  options: Pick<AwsEc2AllocatorOptions, "accessKeyId" | "secretAccessKey" | "sessionToken" | "region">,
  fetchImpl: typeof fetch = fetch,
): AwsEc2Client {
  const host = `ec2.${options.region}.amazonaws.com`;
  const endpoint = `https://${host}/`;

  async function send(params: Record<string, string>): Promise<string> {
    const now = new Date();
    const amzDate = now.toISOString().replaceAll(/[:-]|\.\d{3}/gu, "");
    const dateStamp = amzDate.slice(0, 8);
    const allParams: Record<string, string> = { ...params, Version: ec2ApiVersion };
    if (options.sessionToken !== undefined) {
      allParams["X-Amz-Security-Token"] = options.sessionToken;
    }
    const query = canonicalQuery(allParams);
    const authorization = authorizationHeader(
      {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region: options.region,
        host,
        amzDate,
        dateStamp,
      },
      query,
    );
    const headers: Record<string, string> = { authorization, "x-amz-date": amzDate };
    if (options.sessionToken !== undefined) {
      headers["x-amz-security-token"] = options.sessionToken;
    }
    const response = await fetchImpl(`${endpoint}?${query}`, { method: "GET", headers });
    const body = await response.text();
    if (!response.ok) {
      throw new AwsEc2AllocatorError(`aws ec2 ${params["Action"]} failed: ${response.status} ${body}`);
    }
    return body;
  }

  return {
    async runInstances(input: AwsRunInstancesInput): Promise<AwsEc2Instance> {
      return toInstance(await send(runInstancesParams(input)));
    },

    async describeInstance(instanceId: string): Promise<AwsEc2Instance> {
      return toInstance(await send({ Action: "DescribeInstances", "InstanceId.1": instanceId }));
    },

    async terminateInstance(instanceId: string): Promise<void> {
      // EC2 TerminateInstances is idempotent: terminating an already-gone
      // instance returns InvalidInstanceID.NotFound, which we treat as success.
      try {
        await send({ Action: "TerminateInstances", "InstanceId.1": instanceId });
      } catch (error) {
        if (error instanceof AwsEc2AllocatorError && /InvalidInstanceID\.NotFound/u.test(error.message)) {
          return;
        }
        throw error;
      }
    },
  };
}
