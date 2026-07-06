import type { SensitivityRule } from "./sensitivity.js";

// Codex critic #18 — sensitivity rules for the new run-end mandatory-accounting
// LOUD-failure event. Peeled off `sensitivityRules.infra.ts` (which already sits
// at the 500-line cap alongside the broader usage.* telemetry rules) so this
// hardening block lands without pushing that file over. All fields are public
// (no secret values — see the schema in `schemas/usage.ts`).
export const usageAccountingFailedSensitivityRules: SensitivityRule[] = [
  { eventName: "usage.accounting_failed", path: "runId", tag: "public" },
  { eventName: "usage.accounting_failed", path: "priorOutcomeKind", tag: "public" },
  { eventName: "usage.accounting_failed", path: "outcomeDemoted", tag: "public" },
  { eventName: "usage.accounting_failed", path: "detail", tag: "public" },
  { eventName: "usage.accounting_failed", path: "reason", tag: "public" },
];
