import { request } from "node:http";

export interface CreateContainerSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Named volumes to attach as mounts. Maps volume name -> container path. */
  volumes: Array<{ volumeName: string; containerPath: string }>;
  /** Network to connect to. */
  networkName?: string;
  /** Host port to publish container port 22 on (dev only). */
  hostSshPort?: number;
  capAdd?: string[];
  securityOpt?: string[];
}

export interface ContainerInspectResult {
  id: string;
  imageSha: string;
  running: boolean;
}

export interface DockerEngineClient {
  createVolume(name: string, labels?: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  createContainer(spec: CreateContainerSpec): Promise<string>;
  startContainer(id: string): Promise<void>;
  inspectContainer(id: string): Promise<ContainerInspectResult>;
  readContainerFile(id: string, path: string): Promise<Buffer>;
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  removeContainer(id: string, force?: boolean): Promise<void>;
}

const defaultSocketPath = "/var/run/docker.sock";

export class HttpDockerEngineClient implements DockerEngineClient {
  constructor(private readonly options: { socketPath?: string } = {}) {}

  async createVolume(name: string, labels: Record<string, string> = {}): Promise<void> {
    await this.requestJson("POST", "/volumes/create", {
      Name: name,
      Labels: labels,
      Driver: "local",
    });
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.requestBuffer("DELETE", `/volumes/${encodeURIComponent(name)}?force=1`);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async createContainer(spec: CreateContainerSpec): Promise<string> {
    const body: Record<string, unknown> = {
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: spec.labels,
      HostConfig: hostConfigFor(spec),
      ExposedPorts: { "22/tcp": {} },
    };
    if (spec.networkName !== undefined) {
      body["NetworkingConfig"] = {
        EndpointsConfig: { [spec.networkName]: {} },
      };
    }
    const created = await this.requestJson<{ Id: string }>(
      "POST",
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      body,
    );
    return created.Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.requestBuffer("POST", `/containers/${encodeURIComponent(id)}/start`);
  }

  async inspectContainer(id: string): Promise<ContainerInspectResult> {
    const inspected = await this.requestJson<{
      Id: string;
      Image: string;
      State?: { Running?: boolean };
    }>("GET", `/containers/${encodeURIComponent(id)}/json`);
    return {
      id: inspected.Id,
      imageSha: inspected.Image,
      running: inspected.State?.Running === true,
    };
  }

  async readContainerFile(id: string, path: string): Promise<Buffer> {
    const search = new URLSearchParams({ path });
    const archive = await this.requestBuffer(
      "GET",
      `/containers/${encodeURIComponent(id)}/archive?${search.toString()}`,
    );
    return extractSingleTarFile(archive);
  }

  async stopContainer(id: string, timeoutSeconds = 5): Promise<void> {
    try {
      await this.requestBuffer("POST", `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSeconds}`);
    } catch (error) {
      if (!isNotFoundError(error) && !isStateConflictError(error)) {
        throw error;
      }
    }
  }

  async removeContainer(id: string, force = true): Promise<void> {
    try {
      await this.requestBuffer("DELETE", `/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}&v=1`);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const buffer = await this.requestBuffer(method, path, body);
    if (buffer.length === 0) {
      return undefined as unknown as T;
    }
    return JSON.parse(buffer.toString("utf8")) as T;
  }

  private async requestBuffer(method: string, path: string, body?: unknown): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const requestOptions = {
        method,
        path,
        socketPath: this.options.socketPath ?? defaultSocketPath,
        headers:
          payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(payload.length) },
      };
      const req = request(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const error = new Error(
              `Docker API ${method} ${path} failed with status ${status}: ${responseBody.toString("utf8")}`,
            ) as Error & { statusCode: number };
            error.statusCode = status;
            reject(error);
            return;
          }
          resolve(responseBody);
        });
      });
      req.on("error", reject);
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }
}

function hostConfigFor(spec: CreateContainerSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    AutoRemove: false,
    Mounts: spec.volumes.map((volume) => ({
      Target: volume.containerPath,
      Source: volume.volumeName,
      Type: "volume",
    })),
    NetworkMode: spec.networkName ?? "bridge",
    CapAdd: spec.capAdd ?? [],
    SecurityOpt: spec.securityOpt ?? [],
  };
  if (spec.hostSshPort !== undefined) {
    config["PortBindings"] = {
      "22/tcp": [{ HostIp: "0.0.0.0", HostPort: String(spec.hostSshPort) }],
    };
  }
  return config;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (error as { statusCode?: number }).statusCode === 404;
}

/**
 * True when `error` carries a numeric HTTP `statusCode` — i.e. the Docker daemon
 * ANSWERED (any status, even a 404 for a non-existent container). A transport-level
 * failure (daemon down / socket gone) rejects WITHOUT one. Used by the `/healthz`
 * self-check to decide liveness from the STATUS CODE, not a body-string regex.
 */
export function isHttpStatusError(error: unknown): boolean {
  return error instanceof Error && typeof (error as { statusCode?: unknown }).statusCode === "number";
}

function isStateConflictError(error: unknown): boolean {
  return error instanceof Error && (error as { statusCode?: number }).statusCode === 304;
}

function extractSingleTarFile(archive: Buffer): Buffer {
  if (archive.length < 512) {
    throw new Error("Docker archive did not contain a complete tar header");
  }
  const header = archive.subarray(0, 512);
  const name = tarHeaderString(header.subarray(0, 100));
  if (name === "") {
    throw new Error("Docker archive did not contain a file");
  }
  const size = Number.parseInt(tarHeaderString(header.subarray(124, 136)).trim(), 8);
  if (Number.isNaN(size)) {
    throw new TypeError("Docker archive contained a file with an invalid tar size");
  }
  const contentStart = 512;
  const contentEnd = contentStart + size;
  if (contentEnd > archive.length) {
    throw new Error("Docker archive ended before the tar file content was complete");
  }
  return archive.subarray(contentStart, contentEnd);
}

function tarHeaderString(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end >= 0 ? end : value.length).toString("utf8");
}
