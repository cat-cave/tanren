import type { IntegrationSecretStore } from "../../engine/contracts/integrationSecretStore.js";
import type { PrincipalCandidate } from "../../engine/contracts/integrationAuthority.js";
import type { PrincipalVerificationPermit } from "../../engine/contracts/integrationAuthority.js";
import { scopesForSelectedPrincipal } from "../../engine/integrations/principalVerifiers.js";
import type { StagedSecretHandle } from "../../engine/contracts/integrationSecretStore.js";
import type { IntegrationAuthorityRouteDatabase } from "./authorityWrites.js";
import { runDurableLinkSaga, type DurableLinkSagaOutcome } from "./linkSaga.js";

interface SelectedPrincipalSagaInput {
  permit: PrincipalVerificationPermit;
  staged: StagedSecretHandle;
  providerKind: string;
  principal: PrincipalCandidate;
  authKind: string;
  discoveredScopes: string[];
  expiresAt?: string;
}

/** Re-proves provider-specific scopes before reserving the selected identity. */
export async function runSelectedPrincipalSaga(
  database: IntegrationAuthorityRouteDatabase,
  orgId: string,
  secrets: IntegrationSecretStore,
  fetchImpl: typeof fetch,
  input: SelectedPrincipalSagaInput,
): Promise<DurableLinkSagaOutcome> {
  const scopes = await scopesForSelectedPrincipal(
    input.providerKind,
    fetchImpl,
    input.permit,
    input.staged,
    secrets,
    input.principal,
    input.discoveredScopes,
  );
  return runDurableLinkSaga(database, orgId, secrets, {
    permit: input.permit,
    staged: input.staged,
    verified: {
      principal: input.principal,
      authKind: input.authKind,
      scopes,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      selectedPrincipalId: input.principal.providerPrincipalId,
    },
  });
}
