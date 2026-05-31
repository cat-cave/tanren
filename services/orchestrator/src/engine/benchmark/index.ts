// Tanren-method benchmark toolkit — foundation barrel
// (docs/roadmap/tanren-method-benchmark.md). Entities (Zod source of truth) +
// the TrialScorecard projection + the cell/compare aggregation reducers. The
// BenchmarkRunner scheduler + seed corpus are separate follow-ups.

export {
  AcceptResult,
  CiTierSnapshot,
  ExperimentCellRow,
  ExperimentRow,
  ExperimentTrialRow,
  FrozenConfig,
  SeedTaskRef,
} from "./entities.js";

export {
  CostBasisMix,
  TerminalStatus,
  TrialScorecard,
  TrialTokens,
  loadTrialScorecard,
  projectTrialScorecard,
  type CostFact,
  type EventFact,
  type LoadTrialScorecardOptions,
  type RunFacts,
  type TaskFact,
  type TrialProjectionInputs,
} from "./scorecard.js";

export {
  CellComparison,
  CellMetricFigure,
  CellScorecard,
  ComparisonVerdict,
  MetricComparison,
  OneKnobViolationError,
  compareCells,
  deriveCellScorecard,
  differingKnobs,
  type CompareCellsOptions,
  type DeriveCellOptions,
} from "./reducers.js";

export {
  bootstrapMedianCI,
  mannWhitneyU,
  median,
  seededRng,
  type ConfidenceInterval,
  type MannWhitneyResult,
  type Rng,
} from "./stats.js";
