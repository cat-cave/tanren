/**
 * in-15 production seam: the appEnvHash proof GATE the live deploy-on-merge path
 * runs BEFORE a binding's app-env is consumed by a deploy.
 *
 * Invoked from {@link deployOnMergeShared} immediately AFTER the in-14 reconcile
 * (`materializeProductionBindingsForDeploy`) has written `project_app_env` and
 * BEFORE `attachRuntimeAppEnv` reads it. It independently recomputes each ready
 * binding's canonical appEnvHash from the exact rows attach will consume and
 * verifies the hash matches the immutable recorded generation. A binding that
 * cannot prove its immutable app-env (tamper / drift / missing generation /
 * unresolvable secret / output-shape drift) throws
 * {@link BindingAppEnvProofFailedError} LOUD — which the watcher records as a
 * durable trigger-phase `deploy.failed`, blocking the deploy fail-closed.
 */

import type { Pool } from "pg";
import { runWithOrgScope } from "@tanren/db";
import type { ActorRef } from "../state/actor.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../integrations/integrationSecretStoreImpl.js";
import { assertReadyProjectBindingProofs, type ProjectBindingProofScope } from "../integrations/bindingAppEnvProof.js";
import type { IntegrationBindingContractV1 } from "../contracts/integrationBindingContract.js";
import { materializeProductionBindingsForDeploy } from "./materializeProjectBindings.js";

/**
 * Assert every PRODUCTION ready binding of the project proves its appEnvHash, on
 * an org-scoped client (RLS gates the rows). Returns the verified frozen
 * contracts; throws {@link BindingAppEnvProofFailedError} (BLOCK) on any binding
 * that does not verify. A project with no ready bindings is a clean no-op.
 */
export function verifyProductionDeliveryBindingProofs(
  pool: Pool,
  secrets: SecretStore,
  orgId: string,
  projectId: string,
): Promise<IntegrationBindingContractV1[]> {
  const scope: ProjectBindingProofScope = { orgId, projectId, environment: "production" };
  const integrationSecrets = new GenerationAddressedIntegrationSecretStore(secrets);
  return runWithOrgScope(pool, orgId, (client) => assertReadyProjectBindingProofs(client, integrationSecrets, scope));
}

/**
 * The deploy path's single pre-attach binding seam: reconcile the project's ready
 * PRODUCTION bindings into `project_app_env` (in-14) and then PROOF-GATE the result
 * (in-15) before the runtime env attach consumes it. Both steps are idempotent and
 * fail-closed; the gate throws {@link BindingAppEnvProofFailedError} (BLOCK) if any
 * ready binding cannot prove its immutable app-env. Returns the verified contracts.
 */
export async function materializeAndProveProductionBindings(
  pool: Pool,
  secrets: SecretStore,
  orgId: string,
  projectId: string,
  actor: ActorRef,
): Promise<IntegrationBindingContractV1[]> {
  await materializeProductionBindingsForDeploy(pool, secrets, orgId, projectId, actor);
  return verifyProductionDeliveryBindingProofs(pool, secrets, orgId, projectId);
}
