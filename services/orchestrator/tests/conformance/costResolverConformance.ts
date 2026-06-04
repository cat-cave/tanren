// Seam conformance suite for the CostResolver contract
// (`engine/contracts/costResolver.ts`, whose canonical model lives in
// `engine/costs/sources.ts`). Reusable behavior spec invoked once per
// implementation via `describeCostResolverConformance`.
//
// The contract has TWO orthogonal, first-class guarantees and ONE hard rule:
//
//   billingMode — how the credential is billed: per_token | subscription |
//     self_hosted. Every resolution MUST land on exactly one of these.
//
//   costBasis — how the (possibly null) dollar figure was derived:
//     provider_response | ccusage | provider_pricing | credits | unknown. This is
//     an HONEST provenance tag, not a confidence score: it must reflect what was
//     ACTUALLY used. `provider_response` is the provider's OWN authoritative
//     per-call charge (OpenRouter's usage.cost) — the most accurate real spend.
//
//   the §11.3 / §16.3 hard rule — an unresolvable cost is NEVER a fabricated
//     placeholder. When no reliable per-call dollar basis exists, the
//     resolution MUST be `costUsd === null` with `costBasis === "unknown"`.
//     There is no placeholder basis, no "$0 estimate", no invented denominator.
//     The DB enforces the same invariant: cost_records.cost_basis is pinned by
//     a CHECK to exactly {provider_response, ccusage, provider_pricing, credits,
//     unknown, unattributed}, so any basis string OUTSIDE that set is a
//     CHECK-rejected row — a HARD failure, not
//     a silent downgrade. This spec asserts the in-process half of that pact:
//     no impl may emit a costBasis the CHECK would reject, and the unknown
//     state is honest-null, never a placeholder dollar figure.
//
// Because the production resolver keys off the credential auth-ref + CLI (not
// the contract's provider/model fields), the impl-specific seam is a
// `Scenario` list: each scenario names a credential/usage situation and the
// billingMode + costBasis + null-ness the contract REQUIRES for it. The spec
// runs every scenario through the impl's `resolve` and asserts the contract.
// Track C §4 (backfill conformance suites) of docs/roadmap/forward-roadmap.md.
import { describe, expect, it } from "vitest";
import type { CostResolution, CostResolutionInput, CostResolver } from "../../src/engine/contracts/costResolver.js";

// The billing modes the contract permits. Mirrors BillingMode in costs/sources
// and the cost_records.billing_mode CHECK constraint. `unattributed`
// (BUDGET-SAFETY C1) is an UNRECOGNIZED credential ref — a misconfig recorded
// NULL-dollar but flagged so the budget gate fails closed.
const BILLING_MODES = ["per_token", "subscription", "self_hosted", "unattributed"] as const;

// The cost bases the DB CHECK constraint pins cost_records.cost_basis to
// (migration 0016, widened in 0056 for `unattributed`, in 0065 for
// `provider_response`). An impl that emits anything outside this set produces a
// row the CHECK rejects — the hard-failure rule. Mirrors the widened
// cost_records.cost_basis CHECK exactly. `provider_response` is OpenRouter's
// authoritative `usage.cost` — the REAL deduction that outranks every estimate.
const ALLOWED_COST_BASES = [
  "ccusage",
  "provider_response",
  "provider_pricing",
  "credits",
  "unknown",
  "unattributed",
] as const;
type AllowedCostBasis = (typeof ALLOWED_COST_BASES)[number];

export interface Scenario {
  /** Human label for the credential/usage situation under test. */
  readonly name: string;
  /** Contract input the impl resolves (provider, model, disjoint token buckets). */
  readonly input: CostResolutionInput;
  /** The billingMode the contract REQUIRES for this scenario. */
  readonly expectBillingMode: (typeof BILLING_MODES)[number];
  /** The costBasis the contract REQUIRES for this scenario. */
  readonly expectCostBasis: AllowedCostBasis;
  /**
   * Whether the contract REQUIRES costUsd to be null for this scenario. The
   * §11.3/§16.3 rule: an unknown-basis resolution is ALWAYS null-cost; a
   * priced/ccusage basis is non-null. Default false.
   */
  readonly expectNullCost?: boolean;
}

export interface CostResolverConformanceHarness {
  /** Build a fresh resolver instance under test. */
  make(): CostResolver;
  /**
   * The scenarios this impl is expected to honor. Each names the credential /
   * usage situation plus the billingMode + costBasis + null-ness the contract
   * demands. A `FakeCostResolver` declares one (always self_hosted/unknown);
   * the production resolver declares one per (billing mode × cost basis) path.
   */
  readonly scenarios: readonly Scenario[];
}

// True when costUsd is a valid contract value: an honest null OR a non-empty,
// finite, fixed-precision dollar STRING. NEVER a number, NaN, or "".
function isValidCostUsd(costUsd: string | null): boolean {
  if (costUsd === null) {
    return true;
  }
  return typeof costUsd === "string" && costUsd !== "" && Number.isFinite(Number(costUsd));
}

function expectValidResolution(resolution: CostResolution): void {
  // Every resolution MUST classify into exactly one declared billing mode.
  expect(BILLING_MODES).toContain(resolution.billingMode);
  // Every resolution's basis MUST be CHECK-writable — the hard-failure rule.
  // An out-of-set basis (any string the CHECK rejects) cannot persist at all.
  expect(ALLOWED_COST_BASES).toContain(resolution.costBasis as AllowedCostBasis);
  // costUsd is either a fixed-precision dollar STRING or an honest null.
  expect(isValidCostUsd(resolution.costUsd)).toBe(true);
}

/**
 * Behavior spec every CostResolver implementation must pass. Call once per
 * impl:
 *
 *   describeCostResolverConformance("FakeCostResolver", { make, scenarios });
 */
export function describeCostResolverConformance(label: string, harness: CostResolverConformanceHarness): void {
  describe(`CostResolver conformance: ${label}`, () => {
    it("classifies every resolution into a declared billing mode + a CHECK-writable basis", async () => {
      const resolver = harness.make();
      for (const scenario of harness.scenarios) {
        const resolution = await resolver.resolve(scenario.input);
        expectValidResolution(resolution);
      }
    });

    it("attributes the contract-required billing mode for each credential situation", async () => {
      const resolver = harness.make();
      for (const scenario of harness.scenarios) {
        const resolution = await resolver.resolve(scenario.input);
        expect(resolution.billingMode, `billingMode for "${scenario.name}"`).toBe(scenario.expectBillingMode);
      }
    });

    it("attributes an HONEST cost basis for each credential situation", async () => {
      const resolver = harness.make();
      for (const scenario of harness.scenarios) {
        const resolution = await resolver.resolve(scenario.input);
        expect(resolution.costBasis, `costBasis for "${scenario.name}"`).toBe(scenario.expectCostBasis);
      }
    });

    it("never fabricates a cost: an unknown basis is honest-null, a known basis is a real figure", async () => {
      const resolver = harness.make();
      for (const scenario of harness.scenarios) {
        const resolution = await resolver.resolve(scenario.input);
        // §11.3/§16.3: an unknown basis is ALWAYS null-cost (no placeholder, no
        // "$0 estimate", no rejected-basis downgrade); a declared known basis
        // (ccusage / provider_pricing / credits) ALWAYS carries a real, finite,
        // positive dollar figure. The observed pair must equal the required one.
        const expectedIsNull = scenario.expectCostBasis === "unknown";
        // The scenario name rides INSIDE the compared object so a failure names
        // the offending case without a second `expect` argument.
        expect({
          name: scenario.name,
          isNull: resolution.costUsd === null,
          positive: Number(resolution.costUsd) > 0,
        }).toEqual({ name: scenario.name, isNull: expectedIsNull, positive: !expectedIsNull });
      }
    });

    it("honors each scenario's declared null-ness expectation", async () => {
      const resolver = harness.make();
      const nullScenarios = harness.scenarios.filter((scenario) => scenario.expectNullCost === true);
      const resolved = await Promise.all(
        nullScenarios.map(async (scenario) => ({
          name: scenario.name,
          costUsd: (await resolver.resolve(scenario.input)).costUsd,
        })),
      );
      // Every scenario that declared expectNullCost MUST resolve to null cost.
      expect(resolved.filter((entry) => entry.costUsd !== null)).toEqual([]);
    });

    it("is a pure, deterministic mapping: the same input resolves identically", async () => {
      const resolver = harness.make();
      for (const scenario of harness.scenarios) {
        const first = await resolver.resolve(scenario.input);
        const second = await resolver.resolve(scenario.input);
        expect(second.billingMode).toBe(first.billingMode);
        expect(second.costBasis).toBe(first.costBasis);
        expect(second.costUsd).toBe(first.costUsd);
      }
    });
  });
}
