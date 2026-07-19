// Count-integrity helper: turns the acceptance executor's required-plan and
// observed-result facts into the complete child ledger PgAcceptanceRunStore
// persists for one verdict. Unobserved required assertions are explicit.

import type { VerdictAssertionEvidence } from "./verdictStore.js";

export interface RequiredAcceptanceAssertion {
  readonly assertionId: string;
}

export interface ObservedAcceptanceAssertion {
  readonly assertionId: string;
  readonly satisfied: boolean;
}

export function verdictAssertionEvidence(
  assertions: readonly RequiredAcceptanceAssertion[],
  observed: readonly ObservedAcceptanceAssertion[],
): readonly VerdictAssertionEvidence[] {
  const observedByAssertionId = new Map(observed.map((entry) => [entry.assertionId, entry.satisfied]));
  return assertions.map((assertion) => {
    const passed = observedByAssertionId.get(assertion.assertionId);
    return passed === undefined
      ? { assertionId: assertion.assertionId, executed: false }
      : { assertionId: assertion.assertionId, executed: true, passed };
  });
}
