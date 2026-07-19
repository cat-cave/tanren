// gv-3 — real policy/gate hashes on the direct-merge authority path.
//
// The repair: the live `MergeAuthorityBundle` carried a schema-literal policy version
// (`"1"`) and an EMPTY gate-config hash (`""`), so policy-sensitive proof reuse + the
// gate↔land TOCTOU key were illusory. These tests prove:
//   1. `buildMergeAuthorityBundle` stamps the REAL gate-config hash + policy identity it
//      is handed (no more `""` / `"1"`), so they flow into the authority proof key +
//      `authority_decisions`.
//   2. `resolveMergeCandidateGateConfigHash` resolves the candidate's `.tanren/ci.yml`
//      through the CodeHost and hashes it with the SAME `hashGateConfig` the native-queue
//      path keys on — a real ci.yml yields a non-empty hash == `hashGateConfig(cfg)`.
//   3. NEGATIVE CONTROL: two candidates with DIFFERENT CI config → DIFFERENT gate-config
//      hashes (proof reuse refused); an UNRESOLVABLE config FAILS CLOSED (throws) rather
//      than degrading to `""`.

import { describe, expect, it } from "vitest";
import {
  buildMergeAuthorityBundle,
  resolveMergeCandidateGateConfigHash,
  type BuildMergeAuthorityBundleInput,
} from "../src/engine/merge/mergeAuthorityBundleBuild.js";
import { hashGateConfig } from "../src/engine/dag/integrationProofKey.js";
import { resolveCiConfig } from "../src/engine/ci/index.js";
import type { CodeHost } from "../src/engine/contracts/codeHost.js";
import type pg from "pg";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import type { ReviewMergeRunContext } from "../src/engine/workflow/reviewMerge/context.js";

// A minimal valid `.tanren/ci.yml` (block style — the scoped parser is block-only): a
// per-iteration `fast` tier and a `pre_merge`-covering `slow` tier with junit evidence.
const CI_YAML_A = [
  "version: 1",
  "tiers:",
  "  fast:",
  "    - name: tier-1",
  "      run: just tier-1",
  "  slow:",
  "    - name: tier-2",
  "      run: just tier-2",
  "      junitReport: reports/junit.xml",
  "when:",
  "  fast:",
  "    - per_iteration",
  "  slow:",
  "    - pre_merge",
  "",
].join("\n");

// Same SHAPE, one DIFFERENT gate command — a genuine config change the hash must catch.
const CI_YAML_B = CI_YAML_A.replace("run: just tier-2", "run: just tier-2-alt");

/** A CodeHost stub whose `readFile` returns a scripted `.tanren/ci.yml` body (or throws). */
function codeHostReadingCiYaml(read: () => Promise<string | undefined>): CodeHost {
  return { readFile: async () => read() } as unknown as CodeHost;
}

/** A merge context stub carrying only what the gate-config resolver reads. */
function contextWith(headBranch: string): ReviewMergeRunContext {
  return {
    runId: "run_1",
    prUrl: "https://github.com/cat-cave/fix/pull/7",
    headBranch,
  } as unknown as ReviewMergeRunContext;
}

describe("gv-3 resolveMergeCandidateGateConfigHash — real gate-config hash", () => {
  it("resolves the candidate ci.yml and hashes it == hashGateConfig(cfg), non-empty", async () => {
    const host = codeHostReadingCiYaml(async () => CI_YAML_A);
    const hash = await resolveMergeCandidateGateConfigHash(host, contextWith("feat/x"));
    expect(hash).toBe(hashGateConfig(resolveCiConfig(CI_YAML_A)));
    // the whole point — never the former `""`
    expect(hash).not.toBe("");
    // a real sha256 hex digest
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("NEGATIVE CONTROL: two candidates with different CI config → different hashes (reuse refused)", async () => {
    const hashA = await resolveMergeCandidateGateConfigHash(
      codeHostReadingCiYaml(async () => CI_YAML_A),
      contextWith("feat/x"),
    );
    const hashB = await resolveMergeCandidateGateConfigHash(
      codeHostReadingCiYaml(async () => CI_YAML_B),
      contextWith("feat/x"),
    );
    expect(hashA).not.toBe(hashB);
  });

  it('an ABSENT ci.yml resolves to the default tiers — a REAL non-empty hash, never `""`', async () => {
    // no file in the repo
    const host = codeHostReadingCiYaml(async () => {});
    const hash = await resolveMergeCandidateGateConfigHash(host, contextWith("feat/x"));
    expect(hash).toBe(hashGateConfig(resolveCiConfig()));
    expect(hash).not.toBe("");
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('FAIL-CLOSED: an empty head branch throws (cannot key a sound proof), never returns `""`', async () => {
    const host = codeHostReadingCiYaml(async () => CI_YAML_A);
    await expect(resolveMergeCandidateGateConfigHash(host, contextWith(""))).rejects.toThrow(/head branch/u);
  });

  it('FAIL-CLOSED: a host read failure propagates (never a silent `""`)', async () => {
    const host = codeHostReadingCiYaml(async () => {
      throw new Error("substrate read failed");
    });
    await expect(resolveMergeCandidateGateConfigHash(host, contextWith("feat/x"))).rejects.toThrow(
      /substrate read failed/u,
    );
  });

  it('FAIL-CLOSED: an invalid ci.yml throws from resolveCiConfig (never a silent `""`)', async () => {
    const host = codeHostReadingCiYaml(async () => "version: 1\ntiers: {}\nwhen: {}\n");
    await expect(resolveMergeCandidateGateConfigHash(host, contextWith("feat/x"))).rejects.toThrow(Error);
  });
});

describe("gv-3 buildMergeAuthorityBundle — stamps the real hashes it is handed", () => {
  it('stamps the resolved gateConfigHash + policy identity (no `""` / `"1"`)', () => {
    const realGateHash = hashGateConfig(resolveCiConfig(CI_YAML_A));
    const realPolicyIdentity = "policy-sha256:deadbeef";
    const input: BuildMergeAuthorityBundleInput = {
      pool: {} as unknown as pg.Pool,
      runStateWriter: {} as unknown as RunStateWriter,
      codeHost: {} as unknown as CodeHost,
      orgId: "org_1",
      projectConfigRaw: { version: 1 },
      policyIdentity: realPolicyIdentity,
      gateConfigHash: realGateHash,
      gateOutcome: undefined,
      gatedHeadSha: undefined,
      reviewedHeadSha: undefined,
      requiresExactReviewReceipt: false,
      findings: [],
      reviewVerdict: undefined,
      budgetState: { ceilingUsd: undefined, spentUsd: 0 },
      demo: "not_required",
      hitlSignoff: "not_required",
      behaviorGate: { kind: "not_applicable" },
      designRenderGate: { kind: "not_applicable" },
    };
    const bundle = buildMergeAuthorityBundle(input);
    // The gate-config hash is the REAL resolved hash — not the former `""`.
    expect(bundle.gateConfigHash).toBe(realGateHash);
    expect(bundle.gateConfigHash).not.toBe("");
    // The authority `policyVersion` is the REAL policy identity — not the schema-literal `1`.
    expect(bundle.policyVersion).toBe(realPolicyIdentity);
    expect(bundle.policyVersion).not.toBe("1");
  });
});
