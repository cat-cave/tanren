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
export function sentryPrincipalIdentity(orgSlug: string, baseUrl: string): SentryPrincipalIdentity {
  const endpoint = canonicalSentryEndpoint(baseUrl);
  return SentryPrincipalIdentity.parse({ sentryIdentityVersion: "1", orgSlug, baseUrl: endpoint });
}
