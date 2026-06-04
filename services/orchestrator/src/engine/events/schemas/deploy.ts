import { z } from "zod";

// Deploy-on-merge event schema, split out of schemas/integrations.ts to keep each
// file under the 500-line cap.

// Deploy-on-merge ("a deploy happened"): a run's merge triggered a real build +
// release of the merged commit onto the project's deploy app (Vercel/Fly). The
// payload is the observable proof a deploy actually fired — the deploy target
// (provider + app id), the merged source (repo + git ref), the provider's
// deployment id, the resolved live URL, and the reported state. SECURITY: every
// field is non-secret (a URL + ids + a repo slug); the deploy token + the runtime
// env VALUES went only into the provider requests and never into this event.
export const DeployTriggeredPayload = z
  .object({
    /** The deploy provider kind (`deploy.vercel` | `deploy.flyio`). */
    provider: z.string(),
    /** The deployed app/project id the release ran onto. */
    appId: z.string(),
    /** The merged repo, `owner/name`, the deploy was built from. */
    repo: z.string(),
    /** The git ref (branch/sha) the provider built + released. */
    ref: z.string(),
    /** The provider's deployment handle (Vercel deployment id / Fly machine id). */
    deploymentId: z.string(),
    /** The resolved live URL the deployment is reachable at (concrete, no placeholder). */
    url: z.string(),
    /** The deployment state the provider reported (e.g. "QUEUED" | "READY" | "started"). */
    state: z.string(),
  })
  .strict();
