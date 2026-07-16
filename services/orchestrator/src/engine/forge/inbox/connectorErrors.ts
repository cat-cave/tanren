// Intake source-connector fetch errors (no-silent-fallbacks doctrine).
//
// A source connector (`github`/`sentry`) pulls open issues over
// HTTP. The binding doctrine: a credential/auth or transport/HTTP failure is a
// LOUD hard failure, NEVER a quiet degrade to "no issues" (an empty list). Only a
// genuine 200-with-an-empty-list is an empty result.
//
// The prior connectors returned `[]` on ANY non-200 (or a 200 with an
// unparseable body), so a 401 ("bad token") or a 500/transport error looked
// identical to "the project has no open issues" — silently breaking issue
// triage. These two error types make that distinction first-class:
//   • {@link IntakeSourceAuthError} — a 401/403: the credential is missing,
//     expired, or denied. A CREDENTIAL-RESOLUTION failure (a misconfiguration),
//     so the intake poller re-throws it LOUDLY at the tick boundary rather than
//     retrying forever (see `isCredentialResolutionError`).
//   • {@link IntakeSourceFetchError} — any OTHER unexpected response (a 5xx, a
//     rate-limit, an unparseable 200 body): the fetch FAILED, so it is not "no
//     issues". The poller logs it and retries on the next due tick (a genuine
//     transient), but the connector never swallows it as an empty list.

/** The connectors that pull from an external issue/error source. */
export type IntakeSourceProvider = "github" | "sentry";

/**
 * An `issues` source asked for a provider/credential shape that Tanren does not
 * support. Linear/Jira bare-token intake was deleted rather than adapted onto
 * the integration-grant plane; this error keeps a persisted stale config from
 * being mistaken for a transient GitHub failure.
 */
export class UnsupportedInboxProviderError extends Error {
  readonly retriable = false as const;
  readonly requestedProvider: string | null;

  constructor(requestedProvider: string | null, detail: string) {
    super(`unsupported inbox provider configuration: ${detail}`);
    this.name = "UnsupportedInboxProviderError";
    this.requestedProvider = requestedProvider;
  }
}

/**
 * Reject the deleted provider/authority shapes before any secret or provider
 * I/O. Other malformed GitHub fields remain the connector schema's concern.
 */
export function assertSupportedIssuesProvider(config: unknown): void {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return;
  const record = config as Record<string, unknown>;
  if (Object.hasOwn(record, "tokenRef")) {
    throw new UnsupportedInboxProviderError(
      typeof record["provider"] === "string" ? record["provider"] : null,
      "raw tokenRef authority is not supported; configure the GitHub issues provider",
    );
  }
  const provider = record["provider"];
  if (provider !== undefined && provider !== "github") {
    throw new UnsupportedInboxProviderError(
      typeof provider === "string" ? provider : null,
      `issues sources support only provider 'github' (received ${typeof provider === "string" ? `'${provider}'` : "a non-string provider"})`,
    );
  }
}

/**
 * A 401/403 from an intake source: the credential is missing, expired, or denied.
 * This is a CREDENTIAL-RESOLUTION failure (a misconfiguration the operator must
 * fix — rotate/re-grant the token), so `isCredentialResolutionError` classes it
 * with the GitHub credential errors and the poller re-throws it LOUDLY. NOT a
 * silent empty fetch.
 */
export class IntakeSourceAuthError extends Error {
  readonly retriable = false as const;
  readonly provider: IntakeSourceProvider;
  readonly status: number;

  constructor(provider: IntakeSourceProvider, status: number, detail: string) {
    super(
      `${provider} intake source: authentication failed (HTTP ${status}) — ${detail}. ` +
        `The credential is missing, expired, or denied; this is NOT "no issues". ` +
        `Rotate or re-grant the source's token.`,
    );
    this.name = "IntakeSourceAuthError";
    this.provider = provider;
    this.status = status;
  }
}

/**
 * An unexpected non-200 (or a 200 with a body that does not parse to the expected
 * shape) from an intake source: the fetch FAILED, so the result is unknown — it is
 * NOT a genuine empty list. A transient (a 5xx, a rate-limit, a malformed body);
 * the poller logs it and retries next tick, but the connector never degrades it to
 * `[]`.
 */
export class IntakeSourceFetchError extends Error {
  readonly retriable = true as const;
  readonly provider: IntakeSourceProvider;
  readonly status: number;

  constructor(provider: IntakeSourceProvider, status: number, detail: string) {
    super(
      `${provider} intake source: fetch failed (HTTP ${status}) — ${detail}. ` +
        `This is NOT "no issues"; the source could not be read.`,
    );
    this.name = "IntakeSourceFetchError";
    this.provider = provider;
    this.status = status;
  }
}

/**
 * Classify an intake-source HTTP response. A 200 with an array (or, for the
 * GraphQL/REST shapes, a parseable body) is the caller's to map. A 401/403 is a
 * LOUD {@link IntakeSourceAuthError}; any other non-200 is a LOUD
 * {@link IntakeSourceFetchError}. The caller checks the body shape AFTER this for
 * the 200 case and throws {@link IntakeSourceFetchError} on an unparseable 200.
 */
export function assertIntakeResponseOk(provider: IntakeSourceProvider, status: number, detail = ""): void {
  if (status === 200) return;
  if (status === 401 || status === 403) {
    throw new IntakeSourceAuthError(provider, status, detail === "" ? "credential rejected" : detail);
  }
  throw new IntakeSourceFetchError(provider, status, detail === "" ? "unexpected response" : detail);
}
