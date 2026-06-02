// P-APP-ENV-1: propagate a project's TEST-scoped app environment (Plane B) to the
// target repo's CI as GitHub Actions repository SECRETS, so the project's
// `tanren-ci.yml` tests that read e.g. `RESEND_API_KEY` actually find it.
//
// The flow resolves the test-scoped `project_app_env` entries via
// `resolveAppEnvForScope` (secret values read from the SecretStore, org-scoped via
// the caller's QueryClient so RLS gates which project's entries are visible), then
// sets each as an Actions secret through the provider-neutral
// `VcsProvider.setActionsSecret` (GitHub: sealed-box encrypt → PUT). Only the
// `test` scope reaches CI — a `dev`/`runtime`/`build`-only entry is NEVER
// propagated here (CI runs the project's tests, not its dev shell or deploy).
//
// SECURITY: the resolved values are SECRET. They are passed ONLY into the
// encrypted Actions-secret PUT (inside `setActionsSecret`) — never logged, never
// returned, never placed in the emitted event. The emitted `app_env.ci_propagated`
// event (through the org-scoped PgEventStore, mirroring P-APP-ENV-2's
// `app_env.runtime_attached`) carries the repo + the propagated KEY NAMES only.
// This module logs nothing.

import { resolveAppEnvForScope } from "./resolveAppEnv.js";
import type { ResolvedVcsToken, VcsProvider } from "../contracts/vcsProvider.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { EventStore } from "../eventStore.js";
import type { ActorRef } from "../state/actor.js";
import type pg from "pg";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface PropagateAppEnvToCiInput {
  /** Org-scope-carrying client (RLS gates which project's app-env is visible). */
  client: QueryClient;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  /** Where the `app_env.ci_propagated` event is appended (project-scoped, org-RLS'd). */
  events: EventStore;
  /** The repo clone URL; parsed to owner/name by the provider. */
  repoUrl: string;
  projectId: string;
  /** A token already resolved for the target repo (App-first / static). */
  token: ResolvedVcsToken;
  actor: ActorRef;
}

export interface PropagateAppEnvToCiResult {
  /** The Actions-secret names that were set (non-secret). Never the values. */
  secretNames: string[];
}

/**
 * Resolve the project's TEST-scoped app env and set each entry as an Actions
 * repository secret on the target repo. Returns the NAMES set (never values).
 * Emits `app_env.ci_propagated` (repo + names only) when at least one secret was
 * set. A project with no test-scoped entries is a no-op (no secrets set, no event).
 */
export async function propagateAppEnvToCi(input: PropagateAppEnvToCiInput): Promise<PropagateAppEnvToCiResult> {
  // SCOPE GUARANTEE: only `test`-scoped entries — `resolveAppEnvForScope` filters
  // to entries whose `scopes` include `test`, so a dev/runtime/build-only secret
  // is never resolved here and thus never propagated to CI.
  const env = await resolveAppEnvForScope({
    client: input.client,
    secrets: input.secrets,
    projectId: input.projectId,
    scope: "test",
    actor: input.actor,
  });

  const repo = input.vcsProvider.parseRepository(input.repoUrl);
  // Stable order so the emitted KEY list + the per-secret sets are deterministic.
  const names = Object.keys(env).sort();
  for (const name of names) {
    // The plaintext `value` goes ONLY into setActionsSecret's encrypted PUT body.
    await input.vcsProvider.setActionsSecret({ repo, token: input.token, name, value: env[name] as string });
  }

  if (names.length > 0) {
    // Record the propagation — repo + KEY NAMES only, never a value.
    await input.events.append({
      projectId: input.projectId,
      eventType: "app_env.ci_propagated",
      payload: { projectId: input.projectId, repo: { owner: repo.owner, name: repo.name }, secretNames: names },
    });
  }

  return { secretNames: names };
}
