// gv-3 unit proofs: real policy/gate identity replaces schema-literal + empty hash.
// Named gate: `gv3_policy_identity` — would fail if hashProjectPolicy collapsed to
// schema version or canonical land validation stopped rejecting legacy identities.

import { describe, expect, it } from "vitest";
import { migrateProjectConfig } from "../src/engine/config/projectConfig.js";
import { resolveCiConfig } from "../src/engine/ci/index.js";
import {
  hashProjectPolicy,
  isCanonicalContentIdentity,
  landIdentityValidationReason,
  resolveGateConfigHash,
  resolveGateConfigHashFromYaml,
  resolveProjectPolicyIdentity,
} from "../src/engine/governance/policyGateIdentity.js";
import { hashGateConfig } from "../src/engine/dag/integrationProofKey.js";
import { buildMergeAuthorityBundle, resolveLandGateConfigHash } from "../src/engine/merge/mergeAuthorityBundleBuild.js";
import { authorizeAndLand } from "../src/engine/merge/mergeAuthorityGate.js";
import { GitHubCodeHost } from "../src/engine/providers/githubCodeHost.js";

const HEX64 = /^[0-9a-f]{64}$/u;

function authorityInput(gateConfigHash: string, policyVersion: string): Parameters<typeof authorizeAndLand>[0] {
  return {
    codeHost: { fetchRef: async () => "deadbeef" } as never,
    repo: { owner: "o", name: "r" },
    intoMain: "main",
    headBranch: "feature",
    runId: "run_1",
    specId: "spec_1",
    gateConfigHash,
    policyVersion,
    gatedHeadSha: "deadbeef",
    signals: {
      gateOutcome: { passed: true, results: [] },
      findings: [],
      auditPosture: migrateProjectConfig({ version: 1 }).auditPosture,
      reviewVerdict: "approved",
      mergeability: { state: "clean", behind: false, baseBranch: "main", headBranch: "feature" },
      budget: { ceilingUsd: undefined, spentUsd: 0 },
      demo: "not_required",
      hitlSignoff: "not_required",
      conflictsResolved: true,
    },
    store: {} as never,
  };
}

describe("gv3_policy_identity", () => {
  it("hashes governance fields — never the schema literal 1", () => {
    const config = migrateProjectConfig({ version: 1 });
    const { policyHash } = resolveProjectPolicyIdentity(config);
    expect(policyHash).toMatch(HEX64);
    expect(policyHash).not.toBe("1");
    expect(policyHash).not.toBe(String(config.version));
    // Same config → same hash (deterministic).
    expect(hashProjectPolicy(config)).toBe(policyHash);
  });

  it("changes when auditPosture changes (former TOCTOU-proof gap)", () => {
    const base = migrateProjectConfig({ version: 1 });
    const zeroDefect = migrateProjectConfig({
      version: 1,
      auditPosture: { blockReviewAt: "P3", p2p3Handling: "fix-if-idle", autonomousRemediation: false },
    });
    expect(hashProjectPolicy(base)).not.toBe(hashProjectPolicy(zeroDefect));
  });

  it("is stable across non-governance fields (preview URL does not shift identity)", () => {
    const a = migrateProjectConfig({ version: 1, previewUrlPattern: "https://a.example/{pr}" });
    const b = migrateProjectConfig({ version: 1, previewUrlPattern: "https://b.example/{pr}" });
    expect(hashProjectPolicy(a)).toBe(hashProjectPolicy(b));
  });

  it("reuses hashGateConfig as the sole gate algorithm", () => {
    // Documented default CiConfig (no yaml body) — same path the gate uses when
    // `.tanren/ci.yml` is absent.
    const missingYaml: string | undefined = void 0;
    const config = resolveCiConfig(missingYaml);
    expect(resolveGateConfigHash(config)).toBe(hashGateConfig(config));
    expect(resolveGateConfigHashFromYaml()).toBe(hashGateConfig(config));
    expect(resolveGateConfigHash(config)).toMatch(HEX64);
  });

  it("hashes a genuinely absent ci file as the canonical default", async () => {
    const expected = resolveGateConfigHashFromYaml();
    const actual = await resolveLandGateConfigHash(
      { readFile: () => Promise.resolve() } as never,
      "https://github.com/acme/widget/pull/7",
      "c".repeat(40),
    );
    expect(actual).toBe(expected);
    expect(actual).toMatch(HEX64);
  });

  it("fails closed on unreadable, invalid, and malformed provider responses", async () => {
    await expect(
      resolveLandGateConfigHash(
        {
          readFile: async () => {
            throw new Error("provider unavailable");
          },
        } as never,
        "https://github.com/acme/widget/pull/7",
        "c".repeat(40),
      ),
    ).rejects.toThrow(/could not resolve .tanren\/ci.yml/iu);

    await expect(
      resolveLandGateConfigHash(
        { readFile: async () => "version: nope" } as never,
        "https://github.com/acme/widget/pull/7",
        "c".repeat(40),
      ),
    ).rejects.toThrow(/could not resolve .tanren\/ci.yml/iu);

    const malformedHost = new GitHubCodeHost(
      { request: async () => ({ status: 200, body: { encoding: "base64" } }) },
      async () => ({ token: "t" }),
    );
    await expect(
      malformedHost.readFile({ repo: { owner: "acme", name: "widget" }, ref: "c".repeat(40), path: ".tanren/ci.yml" }),
    ).rejects.toThrow(/malformed file response/iu);
    await expect(
      resolveLandGateConfigHash(malformedHost, "https://github.com/acme/widget/pull/7", "c".repeat(40)),
    ).rejects.toThrow(/could not resolve .tanren\/ci.yml/iu);
  });

  it("requires canonical lowercase 64-hex gate and policy identities", () => {
    const canonicalGate = "a".repeat(64);
    const canonicalPolicy = "b".repeat(64);
    expect(isCanonicalContentIdentity(canonicalGate)).toBe(true);
    expect(landIdentityValidationReason({ gateConfigHash: canonicalGate, policyVersion: canonicalPolicy })).toBe(
      undefined,
    );
    expect(landIdentityValidationReason({ gateConfigHash: "", policyVersion: canonicalPolicy })).toBe(
      "blank_gate_config_hash",
    );
    expect(landIdentityValidationReason({ gateConfigHash: " ", policyVersion: canonicalPolicy })).toBe(
      "blank_gate_config_hash",
    );
    expect(landIdentityValidationReason({ gateConfigHash: "A".repeat(64), policyVersion: canonicalPolicy })).toBe(
      "invalid_gate_config_hash",
    );
    expect(landIdentityValidationReason({ gateConfigHash: canonicalGate, policyVersion: "1" })).toBe(
      "invalid_policy_version",
    );
    expect(landIdentityValidationReason({ gateConfigHash: canonicalGate, policyVersion: ` ${canonicalPolicy}` })).toBe(
      "invalid_policy_version",
    );
  });

  it("buildMergeAuthorityBundle stamps real policy hash and never empty gate when provided", () => {
    const projectConfigRaw = { version: 1 as const };
    const expected = resolveProjectPolicyIdentity(projectConfigRaw).policyHash;
    const gateHash = resolveGateConfigHashFromYaml();
    const bundle = buildMergeAuthorityBundle({
      pool: {} as never,
      runStateWriter: {} as never,
      githubHttp: {} as never,
      resolveToken: async () => ({ token: "t" }),
      orgId: "org_1",
      projectConfigRaw,
      gateConfigHash: gateHash,
      gateOutcome: { passed: true, results: [] },
      gatedHeadSha: "abc123",
      findings: [],
      reviewVerdict: "approved",
      budgetState: { spentUsd: 0, notionalUsd: 0, period: "monthly" },
      demo: "not_required",
      hitlSignoff: "not_required",
    });
    expect(bundle.policyVersion).toBe(expected);
    expect(bundle.policyVersion).not.toBe("1");
    expect(bundle.gateConfigHash).toBe(gateHash);
    expect(bundle.gateConfigHash).not.toBe("");
  });

  it("authorizeAndLand blocks on blank gateConfigHash (negative control)", async () => {
    const disposition = await authorizeAndLand(authorityInput("", "b".repeat(64)));
    expect(disposition).toEqual(
      expect.objectContaining({
        kind: "blocked",
        reasons: expect.arrayContaining([expect.stringContaining("gateConfigHash")]),
      }),
    );
  });

  it("authorizeAndLand blocks a directly injected schema-era policyVersion", async () => {
    const disposition = await authorizeAndLand(authorityInput("a".repeat(64), "1"));
    expect(disposition).toEqual(
      expect.objectContaining({
        kind: "blocked",
        reasons: expect.arrayContaining([expect.stringMatching(/policyVersion.*canonical lowercase 64-hex/iu)]),
      }),
    );
  });
});
