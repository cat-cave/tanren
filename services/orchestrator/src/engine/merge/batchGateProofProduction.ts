import type { ProofSubstrate } from "../contracts/cas.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { PgProofSubstrate } from "../cas/pgProofSubstrate.js";
import type pg from "pg";
import { PgCasByteStore } from "../cas/pgCasByteStore.js";
import { PgGateProofBundleSealer } from "./gateProofBundleSealPg.js";

export type BatchProofSubstrate = ProofSubstrate;

/** The one SP-3 substrate shared by the batch's V2 producer and V2 land verifier. */
export function buildBatchProofSubstrate(pool: pg.Pool, secrets: SecretStore): ProofSubstrate {
  return new PgProofSubstrate(pool, secrets);
}

export function buildBatchGateProofSealer(pool: pg.Pool, proofSubstrate: ProofSubstrate): PgGateProofBundleSealer {
  return new PgGateProofBundleSealer(pool, { proofSubstrate, cas: new PgCasByteStore(pool) });
}
