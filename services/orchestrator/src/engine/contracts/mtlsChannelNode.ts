// The real Node mTLS impls behind the `mtlsChannel.ts` contract.
// Kept separate from the contract so the contract stays dependency-light and the
// `node:tls` / `node:https` surface lives in one place.
//
//   - `buildNodeMtlsFetch` — the DATA-PLANE side: a `fetch`-shaped {@link
//     MtlsFetch} that presents a client cert + key + trusted CA on a
//     `node:https` request, so every control-plane call is MUTUALLY
//     authenticated. (Node's global `fetch` cannot pin a per-request client
//     cert, so we build the request on `node:https` directly and wrap it in the
//     `fetch` Response shape the contract promises.)
//   - `nodeMtlsServerOptions` — the CONTROL-PLANE side: `https.createServer` TLS
//     options that REQUIRE + REJECT-unauthorized a client cert against the
//     trusted CA, so Node validates the peer at the TLS layer.
//   - `NodeMtlsPeerVerifier` — reads the already-validated client cert off the
//     inbound socket and returns its subject CN as the peer identity.
//
// Dev certs are generated/self-signed and wired by env (see
// `scripts/dev/gen-mtls-certs.sh` + compose); prod supplies real cert paths via
// the same env. This is a minimal mutual-auth channel, NOT a full PKI.

import { readFileSync } from "node:fs";
import { request as httpsRequest, type ServerOptions as HttpsServerOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import type { MtlsFetch, MtlsPeerIdentity, MtlsPeerVerifier } from "./mtlsChannel.js";

/** Cert material paths for one side of the mTLS channel. */
export interface MtlsCertPaths {
  /** PEM cert this side presents. */
  certPath: string;
  /** PEM private key for {@link certPath}. */
  keyPath: string;
  /** PEM CA bundle used to validate the OTHER side. */
  caPath: string;
}

/** Read a side's cert material off disk into in-memory PEM buffers. */
export function readMtlsCerts(paths: MtlsCertPaths): { cert: Buffer; key: Buffer; ca: Buffer } {
  return {
    cert: readFileSync(paths.certPath),
    key: readFileSync(paths.keyPath),
    ca: readFileSync(paths.caPath),
  };
}

/**
 * Build the data-plane's mTLS `fetch`. Presents the client cert/key + the
 * trusted CA on each `node:https` request, so the control plane can verify THIS
 * caller and this caller verifies the control plane — mutual TLS. The returned
 * function matches the global `fetch` shape so the HTTP claim client is
 * transport-blind.
 */
export function buildNodeMtlsFetch(paths: MtlsCertPaths): MtlsFetch {
  const { cert, key, ca } = readMtlsCerts(paths);
  return (url: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(url);
      const headers = headersToObject(init?.headers);
      const body = typeof init?.body === "string" ? init.body : undefined;
      const req = httpsRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: init?.method ?? "GET",
          headers,
          cert,
          key,
          ca,
          // Verify the control plane's server cert against our CA (mutual auth).
          rejectUnauthorized: true,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve(new Response(text === "" ? null : text, { status: res.statusCode ?? 502 }));
          });
        },
      );
      req.on("error", reject);
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
}

function headersToObject(headers: RequestInit["headers"] | undefined): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Build the control-plane's HTTPS server TLS options: present our server cert,
 * REQUIRE a client cert, and REJECT any client whose cert does not chain to the
 * trusted CA — so Node validates the data-plane peer at the TLS handshake before
 * a request ever reaches the claim handler.
 */
export function nodeMtlsServerOptions(paths: MtlsCertPaths): HttpsServerOptions {
  const { cert, key, ca } = readMtlsCerts(paths);
  return {
    cert,
    key,
    ca,
    requestCert: true,
    rejectUnauthorized: true,
  };
}

/**
 * The control-plane verifier: pulls the TLS-validated client cert off the
 * inbound socket and returns its subject CN as the peer identity. Because the
 * HTTPS server was built with `rejectUnauthorized: true`, an untrusted cert
 * never reaches here — but we still defend: a missing/unauthorized cert yields
 * `undefined` (→ 401).
 */
export class NodeMtlsPeerVerifier implements MtlsPeerVerifier {
  verify(input: { headers: Headers; socket?: unknown }): MtlsPeerIdentity | undefined {
    const socket = input.socket as Partial<TLSSocket> | undefined;
    if (socket?.authorized !== true || typeof socket.getPeerCertificate !== "function") {
      return undefined;
    }
    const commonName = certCommonName(socket.getPeerCertificate());
    return commonName === undefined ? undefined : { commonName };
  }
}

/** Extract the subject Common Name from a Node peer certificate object. */
export function certCommonName(peer: { subject?: { CN?: string | string[] } } | undefined): string | undefined {
  const cn = peer?.subject?.CN;
  const value = Array.isArray(cn) ? cn[0] : cn;
  return value === undefined || value === "" ? undefined : value;
}
