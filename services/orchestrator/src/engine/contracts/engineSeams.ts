// The PLUGGABLE, not-load-bearing engine surfaces (tanren-owns-the-engine.md §1,
// §6) — the two places a provider is genuinely OPTIONAL, distinct from the four
// purpose-based seams. GitHub is "a code source, maybe an OAuth surface, maybe an
// issue source — fundamentally NOT the engine."
//
// WHY here (the audit it addresses): §6 severs the load-bearing GitHub coupling so
// GitHub/GitLab/Bitbucket/self-host differ only in `CodeHost` mechanics. These two
// surfaces are where GitHub is ONE candidate among N: an OAuth IdP (operator login)
// and an issue source (the inbox connector). They REFERENCE the existing connector
// shapes (an `IngestedItem` mirrors the inbox; an OAuth IdP mirrors the operator
// login) rather than duplicating them — this is the contract surface Wave-1/2 align
// the existing connectors onto, not a parallel re-implementation.

// ---- IssueSource (the inbox connector — GitHub is one of N) ----------------

/**
 * One item ingested from an issue source, reduced to what the planner reasons over.
 * Provider-neutral: a GitHub issue, a Slack thread, an email, or an operator
 * note all map onto this. Mirrors the existing inbox `IngestedItem` shape (Wave-2
 * aligns the inbox connector onto this contract — it is NOT a new parallel type).
 */
export interface IngestedItem {
  /** The source-local id (e.g. GitHub issue number, Slack ts) — for idempotency. */
  externalId: string;
  title: string;
  body: string;
  /** The source kind that produced it (`github` is one of several). */
  sourceKind: string;
}

/** A reference to a configured issue source to fetch from. */
export interface IssueSourceRef {
  sourceKind: string;
  /** The opaque source locator (repo full name, channel id, mailbox, …). */
  locator: string;
}

/**
 * An issue source — a pluggable inbox connector. GitHub is ONE candidate source,
 * not the engine. Wave-2 aligns the existing inbox connectors onto this seam.
 */
export interface IssueSource {
  /** Fetch the not-yet-ingested items from the configured source. */
  fetch(source: IssueSourceRef): Promise<IngestedItem[]>;
}

// ---- IdentityProvider (operator OAuth login — GitHub is one of N) ----------

/** Input to building the OAuth authorize URL (the operator-login redirect). */
export interface BuildAuthorizeUrlInput {
  /** The opaque, single-use state the callback validates (CSRF). */
  state: string;
  /** The redirect URI the IdP returns the operator to. */
  redirectUri: string;
  /** The requested scopes (provider-neutral strings). */
  scopes: ReadonlyArray<string>;
}

/** The result of exchanging an OAuth code for the operator's identity + tokens. */
export interface ExchangedIdentity {
  /** The IdP-local stable subject id for the operator. */
  subject: string;
  /** The operator's display login/handle, when the IdP exposes one. */
  login?: string;
  /** The access token the connector uses (never logged). */
  accessToken: string;
}

/**
 * An OAuth identity provider — a pluggable operator-login surface. GitHub OAuth is
 * ONE candidate IdP, not the engine. Mirrors the existing operator-login flow
 * (Wave-2 aligns it onto this seam — not a new parallel impl).
 */
export interface IdentityProvider {
  /** Build the authorize-redirect URL for the operator-login flow. */
  buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string;
  /** Exchange the returned OAuth `code` (+ `state`) for the operator's identity. */
  exchangeCode(input: { code: string; state: string; redirectUri: string }): Promise<ExchangedIdentity>;
}
