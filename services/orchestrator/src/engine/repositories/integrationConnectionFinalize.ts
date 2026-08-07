// Compatibility facade for the verified-link finalization API. The branded
// reservation contract is isolated from the SQL/Vault state-machine implementation.
export { assertLinkReservation } from "./integrationConnectionFinalizeContracts.js";
export type {
  FinalizeVerifiedLinkInput,
  FinalizeVerifiedLinkResult,
  LinkReservation,
} from "./integrationConnectionFinalizeContracts.js";
export {
  activateReservedLinkSql,
  finalizeReservedSecret,
  loadDurableLinkStateSql,
  markReservationActivatePendingSql,
  markStagedCleanupCompleteSql,
  reserveVerifiedLinkSql,
} from "./integrationConnectionFinalizeStore.js";
