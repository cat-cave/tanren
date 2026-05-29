// In-memory `fetch` emulating the subset of the 1Password Connect API the
// OnePasswordStore drives, so the conformance suite exercises a real wire
// round-trip (title-filter lookup, create-vs-update, concealed field) rather
// than a trivial map. Each call gets its own backing state.
//
//   GET    /v1/vaults/V/items?filter=title eq "T" -> [{id}] match by title
//   GET    /v1/vaults/V/items/ID                  -> item with fields
//   POST   /v1/vaults/V/items                      -> create item
//   PUT    /v1/vaults/V/items/ID                   -> replace item
//   DELETE /v1/vaults/V/items/ID                   -> remove item (404 if absent)
interface FakeItem {
  id: string;
  title: string;
  fields: { label?: string; value?: unknown }[];
}

export function onePasswordConnectFetch(vaultId: string): typeof fetch {
  const items = new Map<string, FakeItem>();
  const base = `https://connect.example.com/v1/vaults/${vaultId}/items`;
  let nextId = 1;

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Partial<FakeItem>;

    if (method === "GET" && url.startsWith(`${base}?filter=`)) {
      const filter = decodeURIComponent(url.slice(`${base}?filter=`.length));
      const title = /title eq "(.*)"/.exec(filter)?.[1] ?? "";
      const found = [...items.values()].filter((item) => item.title === title);
      return new Response(JSON.stringify(found.map((item) => ({ id: item.id }))), { status: 200 });
    }

    if (method === "POST" && url === base) {
      const id = `item-${nextId++}`;
      items.set(id, { id, title: body.title ?? "", fields: body.fields ?? [] });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }

    const id = url.slice(`${base}/`.length);
    if (method === "GET") {
      const item = items.get(id);
      return item === undefined
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(item), { status: 200 });
    }
    if (method === "PUT") {
      items.set(id, { id, title: body.title ?? "", fields: body.fields ?? [] });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    if (method === "DELETE") {
      return new Response(null, { status: items.delete(id) ? 204 : 404 });
    }

    return new Response("unexpected request", { status: 400 });
  }) as typeof fetch;
}
