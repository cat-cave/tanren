// Unit proof for the §3a proof-reuse KEY DERIVATION (integrationProofKey.ts), Wave-3 /
// Slice-3. The hashes must be DETERMINISTIC + order-independent (so the same gate
// config/env always keys the same proof) and DRIFT-SENSITIVE (a changed config/env is a
// different key → recompute); the component resolution must FAIL CLOSED on a blank
// runner image / absent policy / absent quarantine (never a fabricated default that
// would reuse a stale proof on a half-known key).

import { describe, expect, it } from "vitest";
import type { CiConfigV1 } from "../src/engine/ci/index.js";
import { hashAppEnv, hashGateConfig, resolveLiveKeyComponents } from "../src/engine/dag/integrationProofKey.js";

const CONFIG: CiConfigV1 = {
  version: 1,
  tiers: { fast: [{ name: "lint", run: "oxlint" }], slow: [{ name: "test", run: "vitest" }] },
  when: { fast: ["pre_merge"], slow: ["pre_merge"] },
};

describe("hashGateConfig", () => {
  it("is deterministic for the same config", () => {
    expect(hashGateConfig(CONFIG)).toBe(hashGateConfig(CONFIG));
  });

  it("changes when a step's run command changes (a new gate rule ⇒ recompute)", () => {
    const changed: CiConfigV1 = {
      ...CONFIG,
      tiers: { ...CONFIG.tiers, fast: [{ name: "lint", run: "oxlint --fix" }] },
    };
    expect(hashGateConfig(changed)).not.toBe(hashGateConfig(CONFIG));
  });

  it("changes when the bootstrap changes", () => {
    const withBootstrap: CiConfigV1 = { ...CONFIG, bootstrap: { run: "pnpm i" } };
    expect(hashGateConfig(withBootstrap)).not.toBe(hashGateConfig(CONFIG));
  });

  // THE gate-verdict fail-open fix: `when` selects WHICH tiers run for `pre_merge`
  // (tiersFor reads config.when), so two configs that differ ONLY in `when` run
  // DIFFERENT tiers and MUST hash differently — else a stale PASS would be reused for a
  // changed gate (unproven code merges via a wrong reuse).
  it("changes when the `when` tier mapping changes (a different pre_merge tier set ⇒ recompute)", () => {
    // Same tiers + steps; ONLY the `when` mapping differs — `slow` no longer runs at
    // pre_merge. The gate would run a DIFFERENT set of tiers, so the hash MUST differ.
    const remapped: CiConfigV1 = { ...CONFIG, when: { fast: ["pre_merge"], slow: ["pre_audit"] } };
    expect(hashGateConfig(remapped)).not.toBe(hashGateConfig(CONFIG));
  });

  it("changes when a tier is ADDED to the pre_merge mapping (more tiers run ⇒ recompute)", () => {
    const extraPreMerge: CiConfigV1 = {
      ...CONFIG,
      tiers: { ...CONFIG.tiers, integration: [{ name: "e2e", run: "playwright" }] },
      when: { fast: ["pre_merge"], slow: ["pre_merge"], integration: ["pre_merge"] },
    };
    expect(hashGateConfig(extraPreMerge)).not.toBe(hashGateConfig(CONFIG));
  });

  it("is order-INDEPENDENT in the `when` points (a re-ordering does NOT force a recompute)", () => {
    const reorderedPoints: CiConfigV1 = {
      ...CONFIG,
      tiers: { ...CONFIG.tiers, fast: [{ name: "lint", run: "oxlint" }] },
      when: { fast: ["pre_audit", "pre_merge"], slow: ["pre_merge"] },
    };
    const sameSwapped: CiConfigV1 = {
      ...reorderedPoints,
      when: { fast: ["pre_merge", "pre_audit"], slow: ["pre_merge"] },
    };
    expect(hashGateConfig(reorderedPoints)).toBe(hashGateConfig(sameSwapped));
  });
});

describe("hashAppEnv", () => {
  it("is order-INDEPENDENT (key order does not change the hash)", () => {
    expect(hashAppEnv({ A: "1", B: "2" })).toBe(hashAppEnv({ B: "2", A: "1" }));
  });

  it("changes when a value changes (a changed env ⇒ recompute)", () => {
    expect(hashAppEnv({ A: "1" })).not.toBe(hashAppEnv({ A: "2" }));
  });

  it("an absent/empty env is a STABLE known identity (resolvable, never unresolvable)", () => {
    const absent: Record<string, string> | undefined = undefined;
    expect(hashAppEnv(absent)).toBe(hashAppEnv({}));
  });
});

describe("resolveLiveKeyComponents — fail-closed", () => {
  it("resolves all six when every input is present", () => {
    const c = resolveLiveKeyComponents({
      config: CONFIG,
      runnerImage: "ghcr.io/tanren/runner:latest",
      policyVersion: "3",
      quarantineVersion: "q7",
    });
    expect(c.gateConfigHash.resolved && c.runnerImage.resolved && c.policyVersion.resolved).toBe(true);
    expect(c.appEnvHash.resolved && c.quarantineVersion.resolved).toBe(true);
  });

  it("FAILS CLOSED (unresolvable) on a blank runner image", () => {
    const c = resolveLiveKeyComponents({
      config: CONFIG,
      runnerImage: "  ",
      policyVersion: "1",
      quarantineVersion: "1",
    });
    expect(c.runnerImage.resolved).toBe(false);
  });

  it("FAILS CLOSED (unresolvable) on an absent policyVersion / quarantineVersion", () => {
    const c = resolveLiveKeyComponents({
      config: CONFIG,
      runnerImage: "img",
      policyVersion: undefined,
      quarantineVersion: undefined,
    });
    expect(c.policyVersion.resolved).toBe(false);
    expect(c.quarantineVersion.resolved).toBe(false);
  });
});
