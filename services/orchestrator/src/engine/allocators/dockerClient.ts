import { request } from "node:http";
import { hostname } from "node:os";

export interface DockerContainer {
  id: string;
  imageSha: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  running: boolean;
}

export interface DockerClient {
  findComposeServiceContainer(serviceName: string): Promise<DockerContainer | undefined>;
  readContainerFile(containerId: string, path: string): Promise<Buffer>;
}

interface DockerContainerSummary {
  Id: string;
}

interface DockerContainerInspect {
  Id: string;
  Image: string;
  Config?: {
    Env?: string[];
    Labels?: Record<string, string>;
  };
  State?: {
    Running?: boolean;
  };
}

export class DockerEngineClient implements DockerClient {
  constructor(
    private readonly options: {
      socketPath?: string;
      composeProject?: string;
    } = {}
  ) {}

  async findComposeServiceContainer(serviceName: string): Promise<DockerContainer | undefined> {
    const labels = [`com.docker.compose.service=${serviceName}`];
    const project = this.options.composeProject ?? (await this.currentComposeProject());
    if (project !== undefined) {
      labels.push(`com.docker.compose.project=${project}`);
    }

    const containers = await this.listContainers(labels);
    for (const container of containers) {
      const inspected = normalizeInspect(await this.inspectContainer(container.Id));
      if (inspected.running) {
        return inspected;
      }
    }

    if (containers[0] === undefined) {
      return undefined;
    }
    return normalizeInspect(await this.inspectContainer(containers[0].Id));
  }

  private async currentComposeProject(): Promise<string | undefined> {
    try {
      const inspected = await this.inspectContainer(hostname());
      return inspected.Config?.Labels?.["com.docker.compose.project"];
    } catch {
      return undefined;
    }
  }

  private async listContainers(labels: string[]): Promise<DockerContainerSummary[]> {
    const search = new URLSearchParams({
      all: "1",
      filters: JSON.stringify({ label: labels })
    });
    return await this.requestJson<DockerContainerSummary[]>("GET", `/containers/json?${search.toString()}`);
  }

  private async inspectContainer(containerId: string): Promise<DockerContainerInspect> {
    return await this.requestJson<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(containerId)}/json`);
  }

  async readContainerFile(containerId: string, path: string): Promise<Buffer> {
    const search = new URLSearchParams({ path });
    const archive = await this.requestBuffer("GET", `/containers/${encodeURIComponent(containerId)}/archive?${search.toString()}`);
    return extractSingleTarFile(archive);
  }

  private async requestJson<T>(method: string, path: string): Promise<T> {
    const body = await this.requestBuffer(method, path);
    return JSON.parse(body.toString("utf8")) as T;
  }

  private async requestBuffer(method: string, path: string): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const requestOptions = {
        method,
        path,
        socketPath: this.options.socketPath ?? "/var/run/docker.sock"
      };
      const dockerRequest = request(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `Docker API ${method} ${path} failed with status ${response.statusCode ?? "unknown"}: ${responseBody.toString("utf8")}`
              )
            );
            return;
          }
          resolve(responseBody);
        });
      });
      dockerRequest.on("error", reject);
      dockerRequest.end();
    });
  }
}

function normalizeInspect(inspect: DockerContainerInspect): DockerContainer {
  return {
    id: inspect.Id,
    imageSha: inspect.Image,
    labels: inspect.Config?.Labels ?? {},
    env: parseEnv(inspect.Config?.Env ?? []),
    running: inspect.State?.Running === true
  };
}

function parseEnv(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator >= 0) {
      env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  return env;
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
    throw new Error("Docker archive contained a file with an invalid tar size");
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
