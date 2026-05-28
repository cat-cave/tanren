// P2A-0014: paginated costs read API.
//
// The handler is mounted under `createRunRoutes` because the costs surface
// is run-scoped. This module re-exports the contract type and the loader
// for CLI mirrors and other non-HTTP consumers.

export { RunCostRecord, CursorPage } from "../runs/contract.js";
export { fetchCostsPage, fetchRunCostsForSnapshot } from "../runs/list.js";
