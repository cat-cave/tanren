// paginated events read API.
//
// The actual handler is mounted as part of `createRunRoutes` in
// `../runs/index.ts` so the run-scoped /events path lives next to the rest
// of the run surface. This module re-exports the contract types and the
// data loader for callers that want to compose events outside the HTTP
// layer (e.g. CLI subcommands that mirror the dashboard listing).

export { RunEventRow, ProjectFeedItem, CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../runs/contract.js";
export { fetchEventsPage, fetchFeedPage } from "../runs/list.js";
