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
  .catchall(z.string());
export type SentryPrincipalIdentity = z.infer<typeof SentryPrincipalIdentity>;
const LegacySentryPrincipalIdentity = z
  .object({
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
export class SentryPrincipalRelinkRequiredError extends Error {}
export function requireSentryPrincipalIdentity(value: unknown): SentryPrincipalIdentity {
  const identity = SentryPrincipalIdentity.safeParse(value);
  if (identity.success) return identity.data;
  const legacy = LegacySentryPrincipalIdentity.safeParse(value);
  if (legacy.success) return { ...legacy.data, sentryIdentityVersion: "1" };
  throw new SentryPrincipalRelinkRequiredError("sentry_principal_relink_required");
}
export function sentryPrincipalIdentity(orgSlug: string, baseUrl: string): SentryPrincipalIdentity {
  const endpoint = canonicalSentryEndpoint(baseUrl);
  return requireSentryPrincipalIdentity({ sentryIdentityVersion: "1", orgSlug, baseUrl: endpoint });
}
