// attach a project's RUNTIME-scoped app env to the DEPLOYED app.
//
// The clean engine entrypoint that fills the `envAttachmentRef` seam left
// on the deploy artifact: when a project has a deploy artifact (the `deployRef` in
// its `projects.config`), resolve its runtime-scoped `project_app_env` (secret
// values from the SecretStore) and `setEnvVars` them onto the deployed app via the
// deploy provider — so the live product gets its secrets (e.g. RESEND_API_KEY).
//
// Triggered at deploy time / whenever the app env or the deploy artifact changes;
// callers (the deploy provisioner flow / an onboarding-config writer) invoke this
// after either lands. Idempotent: the providers upsert env vars, so a re-attach is
// safe.
//
// SECURITY — the load-bearing property: the runtime secret VALUE flows ONLY into
// the deploy provider's set-env request (over the injectable transport). It is
// NEVER logged, placed in the emitted event, or returned. The emitted
// `app_env.runtime_attached` event carries only the deploy target + the env KEY
// NAMES. The resolved env map lives on the stack for the single `attachRuntimeEnv`
// call and is then dropped.
//
// Org scope: every read runs under the caller's org-scoped `QueryClient` (RLS gates
// which project's app env + grant are even visible). The deployRef's provider is
// asserted to match the resolved provisioner, so a wrong-provider config can never
// silently attach to the wrong app.

import type { ActorRef } from "../state/actor.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { EventStore } from "../eventStore.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import { resolveAppEnvForScope } from "./resolveAppEnv.js";
import type { DeployEnvVar } from "../provisioners/deployProvisioner.js";
import { deployProvisionerFor } from "./deployProvisionerFor.js";
import type { DeployHttpTransport } from "../provisioners/deployTransport.js";
import { assertDeployOperationAuthority } from "../provisioners/deployOperationAuthority.js";

/**
 * The `deployRef` the deploy provisioner wrote into `projects.config`:
 * the provider kind + the deployed app/project id. The attach flow reads it to
 * know WHICH provider + WHICH app to attach the runtime env onto.
 */
export interface DeployArtifactRef {
  provider: string;
  appId: string;
}

export interface AttachRuntimeAppEnvInput {
  /** Org-scoped query client (RLS gates the app-env + org-grant reads). */
  client: IntegrationQueryClient;
  /** The SecretStore runtime secret refs (and the org deploy token) resolve against. */
  secrets: SecretStore;
  /** The deploy transport the provisioner runs over (scripted fake in tests). */
  transport: DeployHttpTransport;
  /** Where the `app_env.runtime_attached` event is appended (project-scoped). */
  events: EventStore;
  /** The Tanren project whose runtime env is being attached. */
  projectId: string;
  /** The project's org (resolves the deploy provider's active control grant). */
  orgId: string;
  /** The deploy artifact ref from the project's config (the deployRef). */
  deployRef: DeployArtifactRef;
  /** Exact project-selected deploy authority, resolved once by the caller. */
  grant: OrgGrant;
  actor: ActorRef;
}

/** What the attach did — for the caller, never including any secret value. */
export interface AttachRuntimeAppEnvResult {
  /** The provider the env was attached on. */
  provider: string;
  /** The deployed app id the env was attached to. */
  appId: string;
  /** The env var KEY NAMES attached (sorted). NEVER any value. */
  attachedKeys: string[];
}

/**
 * Attach the project's runtime-scoped app env to its deployed app.
 *
 * Steps: (1) resolve the RUNTIME-scoped app env (only entries whose scopes include
 * `runtime`; secret values from the SecretStore); (2) resolve the deploy org grant
 * for the deployRef's provider from the connection authority; (3) assert the grant's
 * provider matches the deployRef provider (no wrong-app attach); (4) hand the vars
 * to the provider's `attachRuntimeEnv` (the values go ONLY there); (5) emit
 * `app_env.runtime_attached` with the deploy target + KEY NAMES only.
 *
 * With no runtime-scoped entries this is a no-op (no provider call, no event) — an
 * app with no runtime secrets needs no attachment.
 */
export async function attachRuntimeAppEnv(input: AttachRuntimeAppEnvInput): Promise<AttachRuntimeAppEnvResult> {
  // Authenticate every exact coordinate before the project-env query or secret
  // resolution. This remains mandatory when the resulting env is empty.
  if (input.grant.orgId !== input.orgId || input.grant.projectId !== input.projectId) {
    throw new Error("attachRuntimeAppEnv: grant org/project does not match requested project");
  }
  assertDeployOperationAuthority(input.deployRef.provider, input.grant, "attach_runtime_env", {
    resourceId: input.deployRef.appId,
    environment: "production",
  });

  // (1) Runtime-scoped app env. A `dev`/`test`-only entry is filtered out here —
  // only entries whose scopes include `runtime` reach the deployed app.
  const env = await resolveAppEnvForScope({
    client: input.client,
    secrets: input.secrets,
    orgId: input.orgId,
    projectId: input.projectId,
    environment: "production",
    scope: "runtime",
    actor: input.actor,
  });

  // Stable order so the emitted KEY list + the provider request are deterministic.
  const keys = Object.keys(env).sort();
  if (keys.length === 0) {
    return { provider: input.deployRef.provider, appId: input.deployRef.appId, attachedKeys: [] };
  }

  // The caller resolves one exact project selection and threads it through env
  // attach and deploy, preventing mixed-account work across the two effects.
  const grant = input.grant;
  // The grant's provider must match the deployRef's — a guard against attaching
  // this project's runtime env onto an app under the wrong provider's grant.
  if (grant.providerKind !== input.deployRef.provider) {
    throw new Error(
      `attachRuntimeAppEnv: grant provider '${grant.providerKind}' does not match deployRef provider '${input.deployRef.provider}'`,
    );
  }

  // (4) Hand the runtime vars to the deploy provider. The VALUES leave this
  // function ONLY here, inside the provider's set-env request.
  const vars: DeployEnvVar[] = keys.map((key) => ({ key, value: env[key] as string }));
  const provisioner = deployProvisionerFor(input.deployRef.provider, {
    transport: input.transport,
    secrets: input.secrets,
  });
  if (provisioner.providerKind !== input.deployRef.provider) {
    throw new Error(
      `attachRuntimeAppEnv: provisioner kind '${provisioner.providerKind}' does not match deployRef provider '${input.deployRef.provider}'`,
    );
  }
  await provisioner.attachRuntimeEnv(grant, input.deployRef.appId, vars);

  // (5) Record the attachment — KEY NAMES only, never a value.
  await input.events.append({
    projectId: input.projectId,
    orgId: input.orgId,
    eventType: "app_env.runtime_attached",
    payload: { provider: input.deployRef.provider, appId: input.deployRef.appId, keys },
  });

  return { provider: input.deployRef.provider, appId: input.deployRef.appId, attachedKeys: keys };
}
