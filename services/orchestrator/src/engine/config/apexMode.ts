// APEX / AUTONOMOUS-MODE reader (`TANREN_APEX_MODE`). The single source of truth for
// "is this orchestrator running the live autonomous apex validation". An apex run has
// NO operator to act on a parked finding or a quarantine that never recurs, so apex
// mode self-configures the autonomy-loop policies the loops need to ACTUATE: the
// autonomous audit posture (Loop 3 — findings re-enter the DAG, the audit-posture
// preflight passes) and the apex flaky threshold (Loop 4 — a single-run flake is
// spec-eligible). Off by default — every other dev/test/prod path keeps the
// conservative, human-in-the-loop defaults.
//
// One reader, never forked: the notification build guard, the audit-posture default
// resolution, and the insight-threshold resolution all read apex mode HERE. The flag
// is read LIVE (`parseOrchestratorEnv(process.env)`, not the frozen `parsedEnv`) so a
// per-process toggle takes effect without a reparse — and the read routes through the
// boot env SCHEMA (the `"0"/"1"` contract; a malformed value fails LOUD at the schema,
// never a quiet coerce), so this file owns no raw `TANREN_*` env access of its own.

import { parseOrchestratorEnv } from "../../envSchema.js";

/**
 * True when the orchestrator runs in apex / autonomous mode (`TANREN_APEX_MODE` = `"1"`).
 * Apex mode self-configures the autonomy-loop policy DEFAULTS so the loops actuate
 * without manual per-run config; off ⇒ the conservative human-in-the-loop defaults stay
 * in force. Read live so a test / a per-process toggle is observed immediately.
 */
export function isApexMode(): boolean {
  return parseOrchestratorEnv(process.env).TANREN_APEX_MODE === "1";
}
