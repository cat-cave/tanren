// In-memory `fetch` emulating the subset of the AWS Secrets Manager JSON API the
// AwsSecretsManagerStore drives, dispatching on the `X-Amz-Target` header so the
// conformance suite exercises a real SigV4-signed wire round-trip rather than a
// trivial map. Each call gets its own backing state.
//
//   PutSecretValue  -> overwrite if present, else ResourceNotFoundException
//   CreateSecret    -> create
//   GetSecretValue  -> read (ResourceNotFoundException if absent)
//   DeleteSecret    -> remove (ResourceNotFoundException if absent)
function notFound(): Response {
  return new Response(JSON.stringify({ __type: "ResourceNotFoundException" }), { status: 400 });
}

export function awsSecretsManagerFetch(): typeof fetch {
  const store = new Map<string, string>();

  return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const target = (headers.get("x-amz-target") ?? "").split(".").pop() ?? "";
    const payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      Name?: string;
      SecretId?: string;
      SecretString?: string;
    };

    switch (target) {
      case "PutSecretValue": {
        const id = payload.SecretId ?? "";
        if (!store.has(id)) {
          return notFound();
        }
        store.set(id, payload.SecretString ?? "");
        return new Response(JSON.stringify({ Name: id }), { status: 200 });
      }
      case "CreateSecret": {
        const id = payload.Name ?? "";
        store.set(id, payload.SecretString ?? "");
        return new Response(JSON.stringify({ Name: id }), { status: 200 });
      }
      case "GetSecretValue": {
        const id = payload.SecretId ?? "";
        if (!store.has(id)) {
          return notFound();
        }
        return new Response(JSON.stringify({ Name: id, SecretString: store.get(id) }), { status: 200 });
      }
      case "DeleteSecret": {
        const id = payload.SecretId ?? "";
        if (!store.delete(id)) {
          return notFound();
        }
        return new Response(JSON.stringify({ Name: id }), { status: 200 });
      }
      case "ListSecrets": {
        // Single page; the store keys ARE the secret names.
        const SecretList = [...store.keys()].map((name) => ({ Name: name }));
        return new Response(JSON.stringify({ SecretList }), { status: 200 });
      }
      default:
        return new Response(JSON.stringify({ __type: "UnknownOperationException" }), { status: 400 });
    }
  }) as typeof fetch;
}
