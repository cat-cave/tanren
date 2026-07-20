import type pg from "pg";
import { buildBatchFragmentEvidenceCapture, buildBatchFragmentEvidenceResolver } from "./batchFragmentEvidence.js";

/** Keep the Pg batch factory's dependency fan-in stable while wiring both live F2 ports. */
export function batchFragmentEvidenceWiring(pool: pg.Pool) {
  return {
    resolveFragmentEvidence: buildBatchFragmentEvidenceResolver(pool),
    captureFragmentEvidence: buildBatchFragmentEvidenceCapture(pool),
  };
}
