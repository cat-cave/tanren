// In-memory `fetch` emulating the subset of Google Secret Manager v1 the
// GcpSecretManagerStore drives, so the conformance suite exercises a real wire
// round-trip (secret-id sanitization + base64 payload encoding) rather than a
// trivial map. Each call gets its own backing state.
//
//   POST .../secrets?secretId=ID          -> create container (409 if exists)
//   POST .../secrets/ID:addVersion        -> set latest value (404 if no container)
//   GET  .../secrets/ID/versions/latest:access -> read latest (404 if absent)
//   DELETE .../secrets/ID                 -> destroy container (404 if absent)
export function gcpSecretManagerFetch(project: string): typeof fetch {
  const containers = new Map<string, string | undefined>();
  const base = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets`;

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (method === "POST" && url.includes("?secretId=")) {
      const id = decodeURIComponent(url.split("?secretId=")[1] ?? "");
      if (containers.has(id)) {
        return new Response("already exists", { status: 409 });
      }
      containers.set(id, undefined);
      return new Response(JSON.stringify({ name: id }), { status: 200 });
    }

    if (method === "POST" && url.endsWith(":addVersion")) {
      const id = idFrom(url.slice(0, -":addVersion".length), base);
      if (!containers.has(id)) {
        return new Response("not found", { status: 404 });
      }
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        payload?: { data?: string };
      };
      containers.set(id, body.payload?.data ?? "");
      return new Response(JSON.stringify({ name: `${id}/versions/1` }), { status: 200 });
    }

    if (method === "GET" && url.endsWith("/versions/latest:access")) {
      const id = idFrom(url.slice(0, -"/versions/latest:access".length), base);
      const data = containers.get(id);
      if (data === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ payload: { data } }), { status: 200 });
    }

    if (method === "DELETE") {
      const id = idFrom(url, base);
      const existed = containers.delete(id);
      return new Response(null, { status: existed ? 200 : 404 });
    }

    return new Response("unexpected request", { status: 400 });
  }) as typeof fetch;
}

function idFrom(url: string, base: string): string {
  return decodeURIComponent(url.slice(`${base}/`.length));
}
