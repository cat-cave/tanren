import { z } from "zod";

// P-INT-2 capability-driven onboarding event schema, split into its own module so
// `schemas/integrations.ts` stays under the 500-line cap. A capability-driven
// onboarding provisioned (or bound) a project-level leaf resource (a Sentry
// project + DSN, a Slack channel, a deploy app) from the org grant. The payload
// narrates WHAT was created/bound by REFERENCE only — capability + provider kind,
// the action (create/bind), the secret-manager REF NAMES the DSN/token were stored
// under (NEVER the secret VALUES), and which runtime surfaces were wired. This is
// the timeline + audit marker the dashboard renders for the capability toggles.
export const IntegrationProvisionedPayload = z
  .object({
    /** The capability the onboarding flow requested (e.g. "errors" | "notify" | "deploy"). */
    capability: z.string(),
    /** The provider kind that satisfied it (e.g. "sentry" | "slack" | "deploy.vercel"). */
    providerKind: z.string(),
    /** Greenfield/create-if-absent vs. brownfield bind-an-existing. */
    action: z.enum(["provision", "bind"]),
    /** The onboarding mode the flow ran under. */
    mode: z.enum(["greenfield", "brownfield"]),
    /** The secret-manager REF NAMES stored (DSN/token refs) — names only, NEVER values. */
    secretRefNames: z.array(z.string()).default([]),
    /** Which runtime surfaces the artifact wired (refs only, no secret material). */
    surfaces: z
      .object({
        inboxSourceId: z.string().optional(),
        notificationTargetId: z.string().optional(),
        projectConfigKeys: z.array(z.string()).default([]),
        deployRef: z.string().optional(),
      })
      .strict(),
  })
  .strict();
