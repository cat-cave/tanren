// A real local HTTP listener that stands in for the orchestrator while CLI
// commands run end-to-end. Tests drive the actual CLI handlers (real global
// `fetch`, real argument parsing, real JSON printing) against this stub and
// assert on the OBSERVABLE outcome — what the user sees printed — plus, where
// the request contract must be pinned, the recorded request's fields by value
// (method / path / query / parsed JSON body). No `fetch` spying, no
// `console.log` call-count assertions: the test reads the request the server
// actually received and the output the command actually produced.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  /** Path without query string, e.g. `/orgs/org_acme/projects`. */
  path: string;
  /** Parsed query parameters, e.g. `{ kind: "github_token" }`. */
  query: Record<string, string>;
  /** Raw request body text (empty string when none was sent). */
  rawBody: string;
  /** Parsed JSON body, or `undefined` when the body was empty/non-JSON. */
  json: unknown;
}

export interface StubServer {
  /** Base URL to point the CLI at, e.g. `http://127.0.0.1:54321`. */
  url: string;
  /** Every request the CLI sent, in arrival order. */
  requests: RecordedRequest[];
  /** The most recently recorded request (throws if none arrived). */
  lastRequest(): RecordedRequest;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(rawBody: string): unknown {
  if (rawBody === "") {
    return undefined;
  }
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Start a stub orchestrator that replies to every request with `responseBody`
 * (JSON, HTTP 200) and records what it received. The fixed reply keeps tests
 * focused on the request contract + the command's rendering of the response.
 */
export async function startStubServer(responseBody: unknown): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const rawBody = await readBody(req);
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const query: Record<string, string> = {};
      for (const [key, value] of requestUrl.searchParams) {
        query[key] = value;
      }
      requests.push({
        method: req.method ?? "GET",
        path: requestUrl.pathname,
        query,
        rawBody,
        json: parseJson(rawBody),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    lastRequest(): RecordedRequest {
      const last = requests.at(-1);
      if (last === undefined) {
        throw new Error("stub server received no requests");
      }
      return last;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
