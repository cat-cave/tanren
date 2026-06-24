// Production {@link GcpComputeClient} backed by `fetch` against the Compute
// Engine v1 API — extracted from `gcpAllocator.ts` to keep that file under the
// 500-line cap.

import type { GcpAllocatorOptions } from "./gcpAllocator.js";
import {
  GcpAllocatorError,
  type GcpComputeClient,
  type GcpInsertInstanceInput,
  type GcpInstance,
  type GcpOperation,
} from "./gcpShared.js";

const gcpComputeApiBase = "https://compute.googleapis.com/compute/v1";

interface GcpOperationResponse {
  name: string;
  status: string;
  error?: { errors?: ReadonlyArray<{ message?: string }> | null } | null;
}

interface GcpAccessConfigResponse {
  natIP?: string;
}

interface GcpNetworkInterfaceResponse {
  accessConfigs?: ReadonlyArray<GcpAccessConfigResponse> | null;
}

interface GcpInstanceResponse {
  name: string;
  status: string;
  networkInterfaces?: ReadonlyArray<GcpNetworkInterfaceResponse> | null;
}

function operationErrorOf(error: GcpOperationResponse["error"]): string | undefined {
  if (error === null || error === undefined) {
    return undefined;
  }
  const errors = error.errors;
  if (errors === null || errors === undefined || errors.length === 0) {
    return undefined;
  }
  return errors.map((e) => e.message ?? "unknown error").join("; ");
}

function toOperation(body: GcpOperationResponse): GcpOperation {
  return { name: body.name, status: body.status, error: operationErrorOf(body.error) };
}

function externalIpOf(interfaces: ReadonlyArray<GcpNetworkInterfaceResponse> | null | undefined): string | undefined {
  if (interfaces === null || interfaces === undefined) {
    return undefined;
  }
  for (const iface of interfaces) {
    for (const config of iface.accessConfigs ?? []) {
      if (config.natIP !== undefined && config.natIP !== "") {
        return config.natIP;
      }
    }
  }
  return undefined;
}

function toInstance(body: GcpInstanceResponse): GcpInstance {
  return {
    name: body.name,
    status: body.status,
    externalIp: externalIpOf(body.networkInterfaces),
  };
}

/**
 * Production {@link GcpComputeClient} backed by `fetch` against the Compute
 * Engine v1 API. The access token is supplied by the caller (minted from a
 * Vault-resolved service-account ref), never read from the environment here.
 */
export function fetchGcpComputeClient(
  options: Pick<GcpAllocatorOptions, "accessToken" | "project" | "zone">,
  fetchImpl: typeof fetch = fetch,
): GcpComputeClient {
  const { accessToken, project, zone } = options;
  const authHeaders = {
    authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  } as const;
  const zoneBase = `${gcpComputeApiBase}/projects/${project}/zones/${zone}`;

  return {
    async insertInstance(input: GcpInsertInstanceInput): Promise<GcpOperation> {
      const response = await fetchImpl(`${zoneBase}/instances`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: input.name,
          machineType: `zones/${zone}/machineTypes/${input.machineType}`,
          labels: input.labels,
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: { sourceImage: input.sourceImage },
            },
          ],
          networkInterfaces: [{ accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }] }],
          metadata: {
            items: [{ key: "ssh-keys", value: `${input.sshUsername}:${input.sshPublicKey}` }],
          },
        }),
      });
      if (!response.ok) {
        throw new GcpAllocatorError(`gcp insertInstance failed: ${response.status} ${await response.text()}`);
      }
      return toOperation((await response.json()) as GcpOperationResponse);
    },

    async getZoneOperation(operationName: string): Promise<GcpOperation> {
      const response = await fetchImpl(`${zoneBase}/operations/${operationName}`, {
        method: "GET",
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new GcpAllocatorError(`gcp getZoneOperation failed: ${response.status} ${await response.text()}`);
      }
      return toOperation((await response.json()) as GcpOperationResponse);
    },

    async getInstance(instanceName: string): Promise<GcpInstance> {
      const response = await fetchImpl(`${zoneBase}/instances/${instanceName}`, {
        method: "GET",
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new GcpAllocatorError(`gcp getInstance failed: ${response.status} ${await response.text()}`);
      }
      return toInstance((await response.json()) as GcpInstanceResponse);
    },

    async deleteInstance(instanceName: string): Promise<void> {
      const response = await fetchImpl(`${zoneBase}/instances/${instanceName}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      // 404 means already gone — treat as success (idempotent destroy).
      if (!response.ok && response.status !== 404) {
        throw new GcpAllocatorError(`gcp deleteInstance failed: ${response.status} ${await response.text()}`);
      }
    },
  };
}
