// Code-integrity r3 (finding #2): a Docker JSON endpoint that returns an EMPTY
// BODY must throw LOUDLY with the endpoint in the message — NOT fabricate a fake
// typed object (`undefined as unknown as T`) that only blows up later at an
// unrelated `.Id` access with no endpoint context. `createContainer` reads
// `created.Id` off `requestJson<{ Id }>`; this proves an empty `/containers/create`
// response fails AT the request, naming the endpoint (no silent fabrication).
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpDockerEngineClient } from "../src/dockerEngine.js";

interface StubResponse {
  status: number;
  body: string;
}

let server: Server | undefined;
let socketDir: string | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;
  }
  if (socketDir !== undefined) {
    rmSync(socketDir, { recursive: true, force: true });
    socketDir = undefined;
  }
});

// Stand up a docker-socket-shaped HTTP server on a unix socket that answers every
// request with the supplied status + body, and return a client pointed at it.
async function clientAnswering(response: StubResponse): Promise<HttpDockerEngineClient> {
  socketDir = mkdtempSync(join(tmpdir(), "docker-stub-"));
  const socketPath = join(socketDir, "docker.sock");
  server = createServer((_req, res) => {
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(response.body);
  });
  await new Promise<void>((resolve) => {
    server?.listen(socketPath, resolve);
  });
  return new HttpDockerEngineClient({ socketPath });
}

describe("HttpDockerEngineClient requestJson — empty/invalid body on a JSON endpoint", () => {
  it("throws with the endpoint context on an EMPTY body (never fabricates a fake { Id })", async () => {
    const client = await clientAnswering({ status: 201, body: "" });
    await expect(client.createContainer({ name: "c", image: "img", env: {}, labels: {}, volumes: [] })).rejects.toThrow(
      /\/containers\/create\?name=c.*empty body/u,
    );
  });

  it("throws with the endpoint context on a NON-OBJECT JSON body", async () => {
    const client = await clientAnswering({ status: 200, body: '"not-an-object"' });
    await expect(client.inspectContainer("abc")).rejects.toThrow(/\/containers\/abc\/json.*non-object JSON body/u);
  });

  it("returns the parsed object when the body is a real JSON object", async () => {
    const client = await clientAnswering({ status: 201, body: JSON.stringify({ Id: "container-xyz" }) });
    const id = await client.createContainer({ name: "c", image: "img", env: {}, labels: {}, volumes: [] });
    expect(id).toBe("container-xyz");
  });
});
