// Plane-split P2: the control↔data-plane authenticated transport seam (locked
// decision #3 = mTLS). This is a CONTRACT-shaped seam: the data plane reaches
// the control plane through a `fetch`-shaped {@link MtlsFetch}, and the control
// plane authenticates a caller through an {@link MtlsPeerVerifier}. Both are
// interfaces so the claim path is testable WITHOUT real TLS (an in-process fake
// transport + a fake verifier) and swappable (a signed-JWT impl could slot in
// without touching the claim logic).
//
// The real Node impls (`buildNodeMtlsFetch` / `nodeMtlsServerOptions` /
// `certCommonName`) live in `mtlsChannelNode.ts` — kept out of this contract
// module so the contract stays dependency-light and the impl carries the
// `node:tls`/`undici` surface. See docs/roadmap/saas-rls-and-plane-split-plan.md
// (plane-split P2).

/**
 * A `fetch`-shaped function the data plane calls the control plane through. The
 * real impl pins a client certificate + the trusted CA onto the request agent so
 * the call is MUTUALLY authenticated; a fake impl routes straight to an
 * in-process handler for tests. Intentionally matches the global `fetch`
 * signature so call sites are transport-agnostic.
 */
export type MtlsFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The trusted identity a verified mTLS client certificate carries. */
export interface MtlsPeerIdentity {
  /** The client certificate's subject Common Name (the service identity). */
  commonName: string;
}

/**
 * Authenticates an inbound control-plane request as a trusted data-plane peer.
 * The real impl reads the verified client cert off the TLS socket (Node has
 * already validated it against the trusted CA at the TLS layer) and returns its
 * identity; an UNVERIFIED or untrusted caller yields `undefined`, which the
 * claim endpoint turns into a 401. A fake impl lets tests assert the
 * authn-reject path without standing up TLS.
 */
export interface MtlsPeerVerifier {
  /**
   * Resolve the verified peer identity for a request, or `undefined` when the
   * caller did not present a trusted, TLS-verified client certificate.
   *
   * @param headers the request headers (a real reverse-proxy/mesh deployment may
   *   forward the verified identity as a header; the in-process Node impl reads
   *   the socket instead and ignores these).
   * @param socket the raw connection (the Node impl pulls the peer cert off it).
   */
  verify(input: { headers: Headers; socket?: unknown }): MtlsPeerIdentity | undefined;
}

/**
 * A test/dev verifier that trusts every caller (NO mTLS). Used ONLY by the
 * in-process single-process path and unit tests; a deployment that wants real
 * service identity wires the Node verifier. Returns a fixed identity so the
 * endpoint's "is there a trusted peer?" gate passes.
 */
export class AllowAllPeerVerifier implements MtlsPeerVerifier {
  constructor(private readonly identity: MtlsPeerIdentity = { commonName: "in-process" }) {}

  verify(): MtlsPeerIdentity {
    return this.identity;
  }
}

/**
 * A verifier that rejects EVERY caller (no trusted peer). The default the claim
 * endpoint falls back to when no real verifier is wired, so an un-configured
 * deployment fails CLOSED (401) rather than open.
 */
export class DenyAllPeerVerifier implements MtlsPeerVerifier {
  verify(): undefined {
    return undefined;
  }
}
