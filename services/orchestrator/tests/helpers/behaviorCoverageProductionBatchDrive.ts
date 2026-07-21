import { generateKeyPairSync } from "node:crypto";
import type { Pool } from "pg";
import { PgProofSubstrate, PROOF_SIGNING_KEY_REF } from "../../src/engine/cas/pgProofSubstrate.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { PgIntegrationNodeModel } from "../../src/engine/dag/integrationNodesPg.js";
import { hashGateConfig } from "../../src/engine/dag/integrationProofKey.js";
import { buildBatchGateProofSealer } from "../../src/engine/merge/batchGateProofProduction.js";
import type { BatchNodeDriveDeps } from "../../src/engine/merge/batchIntegrationNodeDrive.js";

/** Real PG/SP-3 V2 dependencies for the behavior-coverage batch-drive integration fixture. */
export async function productionV2BatchDriveDeps(
  pool: Pool,
  integrationBranch: string,
): Promise<Pick<BatchNodeDriveDeps, "nodes" | "gateBundles" | "resolveConfig" | "gate">> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const secrets = new InMemorySecretStore();
  await secrets.put({
    ref: PROOF_SIGNING_KEY_REF,
    value: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  });
  const config = {
    version: 1,
    tiers: { fast: [{ name: "fast", run: "true" }], slow: [{ name: "slow", run: "true" }] },
    when: { fast: ["pre_merge"], slow: ["pre_merge"] },
  } as const;
  const gateConfigHash = hashGateConfig(config);
  return {
    nodes: new PgIntegrationNodeModel(pool),
    gateBundles: buildBatchGateProofSealer(pool, new PgProofSubstrate(pool, secrets)),
    resolveConfig: async () => config,
    gate: async () => ({
      verdict: { result: "pass", integrationBranch },
      passed: true,
      nativeCi: {
        gateConfigHash,
        tiers: ["fast", "slow"],
        steps: [
          { name: "fast", tier: "fast", passed: true },
          { name: "slow", tier: "slow", passed: true },
        ],
        junit: { total: 2, failures: 0, skipped: 0 },
        verdict: "passed",
      },
    }),
  };
}
