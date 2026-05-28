// Usage monitoring surface: live subscription-window state (codexbar) and
// token-consumption accounting (ccusage), both run in the runner over SSH.
//
// TODO(P2A-cost-monitors-wiring): the planner/writer loop will consume these
// (window pre-flight + ccusage cost-basis) in the next PR. This PR only
// exposes the contracts, parsers, SSH adapters, the pressure helper, and the
// usage.* events.
export type {
  CcusageAccounting,
  CcusageModelUsage,
  SubscriptionWindow,
  UsageAccountant,
  UsageMonitor,
  WindowUsage
} from "./contracts.js";
export { parseCodexbarUsage } from "./codexbarParser.js";
export { parseCcusageAccounting } from "./ccusageParser.js";
export { DEFAULT_WINDOW_PRESSURE_THRESHOLD, evaluateWindowPressure } from "./pressure.js";
export {
  buildCcusageCommand,
  buildCodexbarUsageCommand,
  SshCcusageAccountant,
  SshCodexbarUsageMonitor,
  type UsageNote
} from "./sshMonitors.js";
