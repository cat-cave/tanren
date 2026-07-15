import type { DeployArtifactIdentity, DeployResult } from "./deployProvisioner.js";
import type { DeployHttpTransport } from "./deployTransport.js";

export const FLY_API_BASE = "https://api.machines.dev";

type JsonRecord = Record<string, unknown>;

interface FlyLifecycleInput {
  transport: DeployHttpTransport;
  token: string;
  appName: string;
  deploymentId: string;
}

function jsonRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value !== "");
}

function machineUrl(appName: string, deploymentId?: string): string {
  const base = `${FLY_API_BASE}/v1/apps/${encodeURIComponent(appName)}/machines`;
  return deploymentId === undefined ? base : `${base}/${encodeURIComponent(deploymentId)}`;
}

async function readMachine(input: FlyLifecycleInput, operation: string): Promise<JsonRecord> {
  const response = await input.transport.request({
    method: "GET",
    url: machineUrl(input.appName, input.deploymentId),
    headers: { authorization: `Bearer ${input.token}` },
  });
  if (!response.ok) {
    throw new Error(
      `fly ${operation}: get machine '${input.deploymentId}' on '${input.appName}' failed: ` +
        `${String(response.status)} ${response.text}`,
    );
  }
  return jsonRecord(response.json);
}

function digestFromImage(image: string | undefined): string | undefined {
  if (image === undefined) return undefined;
  const separator = image.lastIndexOf("@");
  const candidate = separator === -1 ? image : image.slice(separator + 1);
  return candidate.startsWith("sha256:") ? candidate : undefined;
}

/** Read the immutable digest Fly reports for a released Machine image. */
export async function resolveFlyArtifactIdentity(input: FlyLifecycleInput): Promise<DeployArtifactIdentity> {
  const machine = await readMachine(input, "resolve artifact");
  const imageRef = jsonRecord(machine["image_ref"]);
  const config = jsonRecord(machine["config"]);
  const artifactDigest =
    firstString(imageRef["digest"], machine["artifactDigest"]) ??
    digestFromImage(firstString(config["image"], machine["image"]));
  if (artifactDigest === undefined) {
    throw new Error(
      `fly resolve artifact: machine '${input.deploymentId}' on '${input.appName}' reported no image digest`,
    );
  }
  const checksum = firstString(imageRef["checksum"], machine["checksum"]);
  const providerChecksum =
    firstString(imageRef["providerChecksum"], imageRef["sha512"], machine["providerChecksum"], machine["sha512"]) ??
    (checksum?.startsWith("sha256:") === true ? undefined : checksum) ??
    null;
  return { artifactDigest, providerChecksum };
}

function pinnedImage(config: JsonRecord, imageRef: JsonRecord, input: FlyLifecycleInput): string {
  const currentImage = firstString(config["image"]);
  const digest = firstString(imageRef["digest"]) ?? digestFromImage(currentImage);
  if (currentImage === undefined || digest === undefined) {
    throw new Error(
      `fly traffic transition: target machine '${input.deploymentId}' on '${input.appName}' reported no immutable image`,
    );
  }
  const separator = currentImage.lastIndexOf("@");
  const repository = separator === -1 ? currentImage : currentImage.slice(0, separator);
  return `${repository}@${digest}`;
}

async function retireOtherMachines(
  input: FlyLifecycleInput,
  keepId: string,
  operation: "promote" | "rollback",
): Promise<void> {
  const list = await input.transport.request({
    method: "GET",
    url: machineUrl(input.appName),
    headers: { authorization: `Bearer ${input.token}` },
  });
  if (!list.ok || !Array.isArray(list.json)) {
    throw new Error(
      `fly ${operation}: list machines on '${input.appName}' failed: ${String(list.status)} ${list.text}`,
    );
  }
  for (const candidate of list.json) {
    const machineId = firstString(jsonRecord(candidate)["id"]);
    if (machineId === undefined || machineId === keepId) continue;
    const deleted = await input.transport.request({
      method: "DELETE",
      url: `${machineUrl(input.appName, machineId)}?force=true`,
      headers: { authorization: `Bearer ${input.token}` },
    });
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(
        `fly ${operation}: retire machine '${machineId}' on '${input.appName}' failed: ` +
          `${String(deleted.status)} ${deleted.text}`,
      );
    }
  }
}

/** Release the target Machine's exact image, then make it the app's sole traffic target. */
export async function transitionFlyDeployment(
  input: FlyLifecycleInput & { operation: "promote" | "rollback" },
): Promise<DeployResult> {
  const target = await readMachine(input, input.operation);
  const config = jsonRecord(target["config"]);
  const imageRef = jsonRecord(target["image_ref"]);
  if (Object.keys(config).length === 0) {
    throw new Error(
      `fly ${input.operation}: target machine '${input.deploymentId}' on '${input.appName}' returned no config`,
    );
  }
  const response = await input.transport.request({
    method: "POST",
    url: machineUrl(input.appName),
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: { config: { ...config, image: pinnedImage(config, imageRef, input) } },
  });
  if (!response.ok) {
    throw new Error(
      `fly ${input.operation}: release target '${input.deploymentId}' on '${input.appName}' failed: ` +
        `${String(response.status)} ${response.text}`,
    );
  }
  const body = jsonRecord(response.json);
  const deploymentId = firstString(body["id"]);
  if (deploymentId === undefined) {
    throw new Error(`fly ${input.operation}: release on '${input.appName}' returned no machine id`);
  }
  await retireOtherMachines(input, deploymentId, input.operation);
  return {
    deploymentId,
    url: `https://${input.appName}.fly.dev`,
    state: firstString(body["state"]) ?? "created",
  };
}

/** Delete a preview Machine; an already-absent Machine is a successful no-op. */
export async function teardownFlyDeployment(input: FlyLifecycleInput): Promise<void> {
  const response = await input.transport.request({
    method: "DELETE",
    url: `${machineUrl(input.appName, input.deploymentId)}?force=true`,
    headers: { authorization: `Bearer ${input.token}` },
  });
  if (response.ok || response.status === 404) return;
  throw new Error(
    `fly teardown machine '${input.deploymentId}' on '${input.appName}' failed: ` +
      `${String(response.status)} ${response.text}`,
  );
}
