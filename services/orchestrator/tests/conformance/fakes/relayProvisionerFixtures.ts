// Shared TEST fixtures for the product-plane relay provisioner suites (the
// conformance file + the fail-closed file). Kept in one place so both files use
// the SAME project context, grant issuance (through the real authority), relay
// control-token secret, fake fetch, and fixed-binding transport. Never a prod path.

import { testOrgGrant } from "../../helpers/orgGrant.js";
import { InMemorySecretStore } from "../../../src/engine/contracts/secretStore.js";
import { generationSecretRef } from "../../../src/engine/contracts/integrationSecretStore.js";
import type { OrgGrant, ProjectContext } from "../../../src/engine/contracts/integrationProvisioner.js";
import type {
  IntegrationOperationTarget,
  IntegrationPrivilegedOperation,
} from "../../../src/engine/contracts/integrationAuthority.js";
import type {
  ProductRelayTransport,
  RelayBinding,
} from "../../../src/engine/integrations/product/relayMessagingProvisioner.js";

/** The base secret ref the relay control token is stored + resolved under. */
export const RELAY_TOKEN_BASE = "secret://org/relay-control-token";

/** A deterministic project context for the relay suites. */
export const relayProjectCtx = (projectId: string): ProjectContext => ({
  projectId,
  orgId: "org_conf",
  orgSlug: "acme",
  stack: "node",
  name: projectId,
});

/** Issue a product `messaging.send` grant for the relay provisioner via the real authority. */
export const relayGrant = (
  operation: IntegrationPrivilegedOperation,
  ctx: ProjectContext,
  target: IntegrationOperationTarget,
): Promise<OrgGrant> =>
  testOrgGrant({
    providerKind: "slack",
    capability: "messaging.send",
    operation,
    target,
    credentialRef: generationSecretRef(RELAY_TOKEN_BASE, 1),
    metadata: { workspaceId: "T123" },
    orgId: ctx.orgId,
    projectId: ctx.projectId,
  });

/** A secret store seeded with the relay control token at the grant's ref. */
export async function relaySecrets(): Promise<InMemorySecretStore> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: generationSecretRef(RELAY_TOKEN_BASE, 1), value: "relay-control-token-value" });
  return secrets;
}

/** A fake fetch that always returns the given status + JSON body (or empty). */
export function fetchReturning(status: number, body?: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;
}

/** A transport that returns one FIXED binding from every read/write. */
export function relayTransportReturning(binding: RelayBinding): ProductRelayTransport {
  return {
    registerBinding: () => Promise.resolve(binding),
    getBinding: () => Promise.resolve(binding),
    listBindings: () => Promise.resolve([binding]),
    rotateWorkloadCredential: () => Promise.resolve(binding),
    revokeBinding: () => Promise.resolve(),
  };
}
