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
// returned, never placed in the emitted event. The event carries the propagated
// KEY NAMES only (names are non-secret env-var keys). This module logs nothing.

import { resolveAppEnvForScope } from "./resolveAppEnv.js";
import type { ResolvedVcsToken, VcsProvider } from "../contracts/vcsProvider.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { ActorRef } from "../state/actor.js";
import type pg from "pg";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Names-only signal the flow emits after propagating. It carries the project, the
 * repo, and the SECRET NAMES set — NEVER any value. Wired to a structured emitter
 * by the caller (the route); kept off the migration-gated typed event store so
 * adding this signal needs no schema/migration change.
 */
export interface AppEnvCiPropagatedEvent {
  event: "app_env.ci_propagated";
  projectId: string;
  repo: { owner: string; name: string };
  /** The Actions-secret names that were set (non-secret env-var keys). */
  secretNames: string[];
}

export type AppEnvCiPropagatedEmit = (event: AppEnvCiPropagatedEvent) => void | Promise<void>;

export interface PropagateAppEnvToCiInput {
  /** Org-scope-carrying client (RLS gates which project's app-env is visible). */
  client: QueryClient;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  /** The repo clone URL; parsed to owner/name by the provider. */
  repoUrl: string;
  projectId: string;
  /** A token already resolved for the target repo (App-first / static). */
  token: ResolvedVcsToken;
  actor: ActorRef;
  /** Optional names-only emitter (the route wires a structured logger/event). */
  emit?: AppEnvCiPropagatedEmit;
}

export interface PropagateAppEnvToCiResult {
  /** The Actions-secret names that were set (non-secret). Never the values. */
  secretNames: string[];
}

/**
 * Resolve the project's TEST-scoped app env and set each entry as an Actions
 * repository secret on the target repo. Returns the NAMES set (never values).
 * Emits `app_env.ci_propagated` (names only) when an emitter is supplied. A
 * project with no test-scoped entries is a no-op (no secrets set, empty event not
 * forced).
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
  const secretNames: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    // The plaintext `value` goes ONLY into setActionsSecret's encrypted PUT body.
    await input.vcsProvider.setActionsSecret({ repo, token: input.token, name, value });
    secretNames.push(name);
  }

  if (input.emit !== undefined && secretNames.length > 0) {
    await input.emit({
      event: "app_env.ci_propagated",
      projectId: input.projectId,
      repo: { owner: repo.owner, name: repo.name },
      secretNames,
    });
  }

  return { secretNames };
}
