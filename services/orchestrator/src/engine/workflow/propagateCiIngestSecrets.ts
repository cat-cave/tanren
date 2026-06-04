// CI-intelligence (PR2): propagate the CI INGEST secrets to the target repo's
// GitHub Actions repository SECRETS, so `tanren-ci.yml`'s `upload-junit` step can
// authenticate its JUnit-report POST to `POST /webhooks/ci/junit`.
//
// The generated repo's CI HMAC-signs the upload body with `TANREN_RUN_TOKEN` and
// POSTs to `${TANREN_INGEST_URL}/webhooks/ci/junit`. The ingest endpoint validates
// that signature against its configured `ciWebhookSigningSecretRef` — the SAME
// per-installation CI-webhook signing secret (the run id is carried in the BODY,
// derived from the PR run branch, NOT a per-run secret). So the two secrets this
// module sets are REPO-LEVEL and stable:
//   - TANREN_RUN_TOKEN  ← the signing key the ingest endpoint validates against
//   - TANREN_INGEST_URL ← the public base URL the runner POSTs the report to
//
// Each is set via the provider-neutral `VcsProvider.setActionsSecret` (GitHub:
// sealed-box encrypt → PUT). NO silent fallback: when CI ingest is enabled the
// signing-secret ref AND the public base URL are both REQUIRED — a missing one is
// a LOUD config error, never a quiet skip that would ship a workflow whose upload
// always 401s.
//
// SECURITY: the signing-key VALUE is read from the SecretStore and passed ONLY into
// the encrypted Actions-secret PUT (inside `setActionsSecret`) — never logged or
// returned. The propagation is observable via the route response (the secret NAMES
// only); no event carries a value. This module logs nothing.

import type { ResolvedVcsToken, VcsProvider } from "../contracts/vcsProvider.js";
import type { SecretStore } from "../contracts/secretStore.js";

/** The two repo-level Actions-secret names the CI `upload-junit` step reads. */
export const CI_INGEST_TOKEN_SECRET_NAME = "TANREN_RUN_TOKEN";
export const CI_INGEST_URL_SECRET_NAME = "TANREN_INGEST_URL";

export interface PropagateCiIngestSecretsInput {
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  /** The repo clone URL; parsed to owner/name by the provider. */
  repoUrl: string;
  /** A token already resolved for the target repo (App-first / static). */
  token: ResolvedVcsToken;
  /**
   * The SecretStore ref for the CI ingest HMAC signing key — the SAME ref the
   * JUnit ingest endpoint validates against (`ciWebhookSigningSecretRef`). REQUIRED:
   * an unset ref is a LOUD config error (CI ingest cannot authenticate without it).
   */
  signingSecretRef: string;
  /**
   * The public base URL the runner POSTs the report to (the `upload-junit` step
   * appends `/webhooks/ci/junit`). REQUIRED: an unset/empty base is a LOUD config
   * error (the workflow would have nowhere to upload).
   */
  publicBaseUrl: string;
}

export interface PropagateCiIngestSecretsResult {
  /** The Actions-secret names that were set (non-secret). Never the values. */
  secretNames: string[];
}

export class CiIngestSecretMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiIngestSecretMissingError";
  }
}

/**
 * Set the two repo-level CI ingest Actions secrets on the target repo so the
 * generated `tanren-ci.yml` upload step authenticates. Returns the NAMES set
 * (never values) — the route surfaces them in its response.
 *
 * LOUD on misconfig: an unset signing-secret ref or an empty public base URL
 * throws {@link CiIngestSecretMissingError} — never a quiet skip.
 */
export async function propagateCiIngestSecrets(
  input: PropagateCiIngestSecretsInput,
): Promise<PropagateCiIngestSecretsResult> {
  if (input.signingSecretRef === "") {
    throw new CiIngestSecretMissingError(
      "CI ingest signing-secret ref is unset — cannot propagate the JUnit-upload signing key",
    );
  }
  const baseUrl = input.publicBaseUrl.replace(/\/+$/u, "");
  if (baseUrl === "") {
    throw new CiIngestSecretMissingError(
      "CI ingest public base URL is unset — the upload step would have no ingest endpoint",
    );
  }

  // Resolve the signing-key VALUE from the SecretStore (the SAME secret the ingest
  // endpoint verifies against). A missing secret is a LOUD failure, not a skip.
  const signingSecret = await input.secrets.get(input.signingSecretRef);
  if (signingSecret === undefined) {
    throw new CiIngestSecretMissingError(
      `CI ingest signing secret not found in the secret store (ref configured but absent)`,
    );
  }

  const repo = input.vcsProvider.parseRepository(input.repoUrl);

  // The signing-key plaintext goes ONLY into setActionsSecret's encrypted PUT body.
  await input.vcsProvider.setActionsSecret({
    repo,
    token: input.token,
    name: CI_INGEST_TOKEN_SECRET_NAME,
    value: signingSecret.value,
  });
  await input.vcsProvider.setActionsSecret({
    repo,
    token: input.token,
    name: CI_INGEST_URL_SECRET_NAME,
    value: baseUrl,
  });

  // Sorted, deterministic name list — never a value.
  const secretNames = [CI_INGEST_TOKEN_SECRET_NAME, CI_INGEST_URL_SECRET_NAME].sort();
  return { secretNames };
}
