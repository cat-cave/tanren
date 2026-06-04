// cost PR-C: per-credential credit/overage USD-rate resolution.
//
// The dollar value of one prepaid credit is account/plan-specific (the old
// hardcoded $0.04 was a single Codex-Pro observation, NOT a universal constant).
// It is now per-credential CONFIG: a `creditRates` map keyed by the credential's
// SAFE ref-KIND label (`credential/<kind>/...` leading segments, secret name
// stripped — `refKindOf`), at the project layer overriding the org layer.
//
// REAL SPEND IS A FACT: this resolves a rate ONLY from configured data. A
// credential whose kind has NO configured rate returns `null` — the run-end
// reconcile then records NULL real spend + emits a LOUD `cost.credit_rate_unknown`
// rather than multiplying a real drawdown by a removed default. There is NO
// magic-constant fallback here, by design.
import type { CreditRates } from "../config/shared.js";
import { credentialSlugOf } from "./sources.js";

export interface CreditRateResolution {
  // The configured USD-per-credit rate for the credential, or null when no rate
  // is configured for its provider-slug at EITHER the project or the org layer.
  usdPerCredit: number | null;
  // The SAFE provider-slug the rate was looked up under (`credential/<slug>`),
  // for the loud-unknown event. Secret-free.
  refKind: string;
  // Which config layer supplied the rate, for narration. null when unresolved.
  source: "project" | "org" | null;
}

// resolveCreditUsdRate resolves the per-credential credit→USD rate for the run's
// credential ref. Resolution order (first hit wins): the PROJECT `creditRates`
// map, then the ORG `defaultCreditRates` map. Both are keyed by PROVIDER-SLUG, so
// one entry covers every credential of that provider (`credential/codex` → 0.04)
// regardless of its scope/name. An empty/absent authRef (the no-credential /
// fixture path) never draws down credits, so it resolves to a null rate with an
// `unknown` slug — harmless because the reconcile only consults the rate on a
// POSITIVE drawdown.
export function resolveCreditUsdRate(input: {
  authRef: string;
  projectRates: CreditRates;
  orgRates?: CreditRates;
}): CreditRateResolution {
  const refKind = credentialSlugOf(input.authRef);
  const projectRate = positiveRate(input.projectRates[refKind]);
  if (projectRate !== null) {
    return { usdPerCredit: projectRate, refKind, source: "project" };
  }
  const orgRate = positiveRate(input.orgRates?.[refKind]);
  if (orgRate !== null) {
    return { usdPerCredit: orgRate, refKind, source: "org" };
  }
  return { usdPerCredit: null, refKind, source: null };
}

// A rate is believed only when it is a genuine positive, finite number. A
// 0/negative/NaN (or absent) entry is "no rate configured" — never a $0 rate
// (which would silently zero out real overage spend).
function positiveRate(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
