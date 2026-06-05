import { z } from "zod";

// redaction.raw_access is the audit-trail event the redaction layer
// emits when an elevated-scope actor (org:admin or platform:admin) requests
// raw payload values via an explicit raw-view opt-in. The presence of one of
// these rows is the operator-facing proof that a privileged read happened.
//
// We do not record the raw values themselves; only the actor identity, the
// scopes they used, the event row id they read, the paths inside that
// payload that resolved to raw (so we can show "X viewed credentialRef,
// target.host" later), and a timestamp.
export const RedactionRawAccessPayload = z
  .object({
    actorUserId: z.string(),
    actorScopes: z.array(z.string()),
    eventReadId: z.string(),
    eventReadType: z.string(),
    paths: z.array(z.string()),
    at: z.string(),
  })
  .strict();
