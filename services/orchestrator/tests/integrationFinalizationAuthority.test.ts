import { describe, expect, it, vi } from "vitest";
import { integrationCatalogRevision } from "../src/engine/contracts/integrationCatalog.js";
import {
  connectionCredentialBaseRef,
  generationSecretRef,
  type IntegrationSecretStore,
  type StagedSecretHandle,
} from "../src/engine/contracts/integrationSecretStore.js";
import { activateDurableReservationSql } from "../src/engine/repositories/integrationConnectionActivate.js";
import {
  activateReservedLinkSql,
  finalizeReservedSecret,
  loadDurableLinkStateSql,
  markReservationActivatePendingSql,
  type LinkReservation,
} from "../src/engine/repositories/integrationConnectionFinalize.js";
import type { IntegrationQueryClient } from "../src/engine/repositories/integrationQuery.js";
import { testPrincipalVerificationPermit } from "./helpers/orgGrant.js";

describe("integration finalization continuation authority", () => {
  it("rejects cloned reservations before every continuation performs I/O", async () => {
    const permit = await testPrincipalVerificationPermit({
      orgId: "org-test",
      providerKind: "slack",
      actorId: "operator-test",
      operationId: "op-finalize",
    });
    const connectionId = "conn-finalize";
    const baseRef = connectionCredentialBaseRef(permit.orgId, permit.providerKind, connectionId);
    const credentialRef = generationSecretRef(baseRef, 1);
    const loadQuery = vi.fn<IntegrationQueryClient["query"]>().mockResolvedValue({
      rows: [
        {
          id: permit.operationId,
          provider_kind: permit.providerKind,
          connection_id: null,
          operation_kind: "link",
          stage: "finalizing",
          status: "in_progress",
          actor_id: permit.actorId,
          staged_secret_handle: permit.stagedSecretHandle,
          verification_fingerprint: "verified-fingerprint",
          verified_principal: {
            providerPrincipalId: "workspace-1",
            principalKind: "team",
            displayName: "Workspace One",
            metadata: {},
          },
          verified_auth_kind: "oauth",
          verified_scopes: ["channels:read", "channels:manage"],
          verified_expires_at: null,
          reserved_connection_id: connectionId,
          reserved_credential_ref: credentialRef,
          target_auth_generation: 1,
          target_grant_id: "grant-finalize",
          target_grant_generation: 1,
          reserved_capabilities: ["notify"],
          reserved_operations: ["bind", "discover", "provision"],
          reserved_policy_revision: integrationCatalogRevision(),
          reserved_consent_revision: "consent.operator-test.op-finalize",
          reserved_consented_at: "2030-01-01T00:00:00.000Z",
          created_at: "2030-01-01T00:00:00.000Z",
        },
      ],
      rowCount: 1,
    });
    const loaded = await loadDurableLinkStateSql({ query: loadQuery }, permit);
    const reservation = loaded as LinkReservation;
    const cloned = { ...reservation, connectionId: "attacker-coordinate" } as LinkReservation;
    const dbQuery = vi.fn<IntegrationQueryClient["query"]>();
    const finalize = vi.fn<IntegrationSecretStore["finalize"]>();
    const secretStore = { finalize } as unknown as IntegrationSecretStore;
    const staged = {
      operationId: permit.operationId,
      handle: permit.stagedSecretHandle,
    } as StagedSecretHandle;

    await expect(finalizeReservedSecret(secretStore, cloned, staged)).rejects.toThrow(/invalid link reservation/u);
    await expect(markReservationActivatePendingSql({ query: dbQuery }, cloned, credentialRef)).rejects.toThrow(
      /invalid link reservation/u,
    );
    await expect(activateReservedLinkSql({ query: dbQuery }, cloned, credentialRef)).rejects.toThrow(
      /invalid link reservation/u,
    );
    await expect(activateDurableReservationSql({ query: dbQuery }, cloned, credentialRef)).rejects.toThrow(
      /invalid link reservation/u,
    );
    expect(finalize).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();

    await expect(
      finalizeReservedSecret(secretStore, reservation, { ...staged, handle: "secret://integration/staged/other" }),
    ).rejects.toThrow(/operation_staged_handle_conflict/u);
    expect(finalize).not.toHaveBeenCalled();
  });
});
