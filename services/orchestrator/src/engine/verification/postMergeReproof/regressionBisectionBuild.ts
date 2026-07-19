// rv-16b — production composition for the behavior-aware regression bisector: the real
// PgCandidateChainReader (release supersession chain + verdict history), the real
// RealCandidateBehaviorReprover (rv-11 orchestrator + rv-6 driver against the candidate's
// recorded deployment URL), and the append-only PgRegressionBisectionStore (0083).

import type pg from "pg";
import { PgAcceptancePlanLoader } from "../acceptance/index.js";
import { PgCandidateChainReader, PgRegressionBisectionStore } from "../../repositories/regressionBisections.js";
import { RealCandidateBehaviorReprover, RecordedUrlCandidateEnvironmentResolver } from "./candidateReprover.js";
import { RegressionBisector } from "./regressionBisection.js";

export function buildRegressionBisector(pool: pg.Pool): RegressionBisector {
  return new RegressionBisector({
    chainReader: new PgCandidateChainReader(pool),
    reprover: new RealCandidateBehaviorReprover({
      planLoader: new PgAcceptancePlanLoader(pool),
      environmentResolver: new RecordedUrlCandidateEnvironmentResolver(),
    }),
    store: new PgRegressionBisectionStore(pool),
  });
}
