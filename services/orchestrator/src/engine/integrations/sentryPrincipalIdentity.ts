import { z } from "zod";
export function canonicalSentryEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("Sentry endpoint must be an HTTPS origin/path without credentials, query, or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}
export const SentryPrincipalIdentity = z
  .object({
    sentryIdentityVersion: z.literal("1"),
    orgSlug: z.string().min(1),
    baseUrl: z.string().refine((value) => {
      try {
        return canonicalSentryEndpoint(value) === value;
      } catch {
        return false;
      }
    }),
  })
  .strict();
export type SentryPrincipalIdentity = z.infer<typeof SentryPrincipalIdentity>;

/**
 * Grant metadata may carry the verified Sentry identity plus the team used by
 * project creation. Keep this boundary strict so provider-only fields cannot
 * be smuggled into the grant and silently influence provisioning.
 */
export const SentryGrantMetadata = SentryPrincipalIdentity.extend({
  team: z.string().min(1).optional(),
}).strict();
export type SentryGrantMetadata = z.infer<typeof SentryGrantMetadata>;

export class SentryPrincipalRelinkRequiredError extends Error {}
export function requireSentryPrincipalIdentity(value: unknown): SentryPrincipalIdentity {
  const identity = SentryPrincipalIdentity.safeParse(value);
  if (identity.success) return identity.data;
  // Legacy `{ orgSlug, baseUrl }` metadata (no `sentryIdentityVersion`) is NOT a
  // verified v1 identity. Normalizing it would let callers continue into selection,
  // discover, provision, or rotation with an unverified provider identity. It must
  // be rejected so the route surfaces `409 verified_provider_identity_required`.
  throw new SentryPrincipalRelinkRequiredError("sentry_principal_relink_required");
}

export function requireSentryGrantMetadata(value: unknown): SentryGrantMetadata {
  const metadata = SentryGrantMetadata.safeParse(value);
  if (metadata.success) return metadata.data;

  // Preserve the verified-identity boundary for legacy, malformed, or
  // otherwise unrecognized metadata. The fallback deliberately remains the
  // strict identity helper; it must continue to reject legacy identities.
  return requireSentryPrincipalIdentity(value);
}

export function sentryPrincipalIdentity(orgSlug: string, baseUrl: string): SentryPrincipalIdentity {
  const endpoint = canonicalSentryEndpoint(baseUrl);
  return requireSentryPrincipalIdentity({ sentryIdentityVersion: "1", orgSlug, baseUrl: endpoint });
}
