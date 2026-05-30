// Shared injected-fetch IdP harness for the operator-auth mutation guards
// (test/mutation-ratchet-auth). The provider tests record every outbound
// request through a stub `fetch` so each test can assert the real wire shape
// and the mapped IdentityClaims without any network or module mocking.

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

export function recordingFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    const call = { url: typeof input === "string" ? input : input.toString(), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const OIDC_ISSUER = "https://idp.example.com";

export const OIDC_DISCOVERY = {
  issuer: OIDC_ISSUER,
  authorization_endpoint: `${OIDC_ISSUER}/application/o/authorize/`,
  token_endpoint: `${OIDC_ISSUER}/application/o/token/`,
  userinfo_endpoint: `${OIDC_ISSUER}/application/o/userinfo/`,
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
