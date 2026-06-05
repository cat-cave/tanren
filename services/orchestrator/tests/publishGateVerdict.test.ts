// The native gate's verdict PUBLICATION to the forge (the no-Actions delivery model).
// Two invariants are pinned here, both root-caused from a live apex run where a
// fully-PASSING pipeline was halted by an HTTP 403 from the verdict publish:
//
//  1. `publishGateVerdict` issues a COMMIT STATUS (`publishStatus`), never a check-run
//     (`publishCheck`). The Checks API is Apps-only — a token credential gets 403 — so a
//     status is the universal, branch-protection-sufficient primitive for both.
//  2. `publishGateVerdictBestEffort` treats a publish failure as NON-fatal: a thrown
//     403 is CAUGHT (the run proceeds to merge on the internal verdict) and reported via
//     the emit seam. A FAILED gate is never laundered — only a failed PUBLISH of a
//     verdict is swallowed; the merge decision lives in the internal `gate.verdict`.
import { describe, expect, it } from "vitest";
import type {
  PublishCheckInput,
  PublishedCheck,
  PublishStatusInput,
  RepoRef,
  ResolvedVcsToken,
  VcsProvider,
} from "../src/engine/contracts/vcsProvider.js";
import { publishGateVerdict } from "../src/engine/workflow/gate/publishGateVerdict.js";
import { publishGateVerdictBestEffort } from "../src/engine/workflow/gate/publishGateVerdictBestEffort.js";
import type { GateOutcome } from "../src/engine/workflow/gate/runGateForWhen.js";

const REPO: RepoRef = { owner: "cat-cave", name: "tanren-fixture" };
const TOKEN: ResolvedVcsToken = { token: "ghp_fake_token", source: "static", refresh: async () => "ghp_fake_token" };

// A VcsProvider stub that records the publish calls (and can be made to throw). Only the
// two publish methods are real; everything else throws if touched (it must not be).
class RecordingPublishProvider {
  readonly statuses: PublishStatusInput[] = [];
  readonly checks: PublishCheckInput[] = [];
  constructor(private readonly failStatusWith?: Error) {}
  async publishStatus(input: PublishStatusInput): Promise<void> {
    this.statuses.push(input);
    if (this.failStatusWith !== undefined) throw this.failStatusWith;
  }
  async publishCheck(input: PublishCheckInput): Promise<PublishedCheck> {
    this.checks.push(input);
    return { id: 1, url: "https://github.com/x/y/runs/1" };
  }
  parseRepository(_url: string): RepoRef {
    return REPO;
  }
}

const asProvider = (p: RecordingPublishProvider): VcsProvider => p as unknown as VcsProvider;

const passOutcome: GateOutcome = {
  passed: true,
  results: [{ passed: true, tier: "default", when: "pre_merge", steps: [] }],
};
const failOutcome: GateOutcome = {
  passed: false,
  results: [],
  failure: { passed: false, tier: "default", when: "pre_merge", failedStep: "test", exitCode: 1, steps: [] },
};

describe("publishGateVerdict", () => {
  it("publishes a COMMIT STATUS (not a check-run) for a token credential", async () => {
    const provider = new RecordingPublishProvider();
    await publishGateVerdict({
      vcsProvider: asProvider(provider),
      repo: REPO,
      token: TOKEN,
      headSha: "abc123",
      outcome: passOutcome,
    });
    // A status is issued; a check-run is NEVER issued (it would 403 on a token).
    expect(provider.checks).toHaveLength(0);
    expect(provider.statuses).toHaveLength(1);
    const status = provider.statuses[0]!;
    expect(status).toMatchObject({ context: "tanren/gate", state: "success", headSha: "abc123" });
    // The token is passed through to the publish call's auth (never logged), not the body.
    expect(status.token).toBe(TOKEN);
    expect(status.description).toContain("passed");
  });

  it("maps a failed gate to a failure status naming the failing tier + step", async () => {
    const provider = new RecordingPublishProvider();
    await publishGateVerdict({
      vcsProvider: asProvider(provider),
      repo: REPO,
      token: TOKEN,
      headSha: "def456",
      outcome: failOutcome,
    });
    const status = provider.statuses[0]!;
    expect(status.state).toBe("failure");
    expect(status.description).toContain("default");
    expect(status.description).toContain("test");
  });

  it("bounds the description to GitHub's 140-char commit-status limit", async () => {
    const provider = new RecordingPublishProvider();
    const longTiers = Array.from({ length: 30 }, (_, i) => ({
      passed: true as const,
      tier: `tier-${i}`,
      when: "pre_merge" as const,
      steps: [],
    }));
    await publishGateVerdict({
      vcsProvider: asProvider(provider),
      repo: REPO,
      token: TOKEN,
      headSha: "sha",
      outcome: { passed: true, results: longTiers },
    });
    expect(provider.statuses[0]!.description.length).toBeLessThanOrEqual(140);
  });
});

describe("publishGateVerdictBestEffort", () => {
  it("on a publish 403, CATCHES it (does not propagate) and reports via emit — the run proceeds", async () => {
    const provider = new RecordingPublishProvider(new Error("GitHub status publish failed: HTTP 403"));
    const emitted: Array<{ when: string; headSha: string; passed: boolean; reason: string }> = [];
    // A passing verdict whose forge publish 403s MUST resolve normally (no throw).
    await expect(
      publishGateVerdictBestEffort(
        { vcsProvider: asProvider(provider), repo: REPO, token: TOKEN, headSha: "abc123", outcome: passOutcome },
        "pre_merge",
        true,
        async (e) => {
          emitted.push(e);
        },
      ),
    ).resolves.toBeUndefined();
    // The failure is observable: one warning carrying the (non-secret) reason + the verdict.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ when: "pre_merge", headSha: "abc123", passed: true });
    expect(emitted[0]!.reason).toContain("403");
    // The token must NOT appear in the emitted reason.
    expect(emitted[0]!.reason).not.toContain(TOKEN.token);
  });

  it("on a successful publish, emits nothing", async () => {
    const provider = new RecordingPublishProvider();
    const emitted: unknown[] = [];
    await publishGateVerdictBestEffort(
      { vcsProvider: asProvider(provider), repo: REPO, token: TOKEN, headSha: "abc123", outcome: passOutcome },
      "pre_merge",
      true,
      async (e) => {
        emitted.push(e);
      },
    );
    expect(emitted).toHaveLength(0);
    expect(provider.statuses).toHaveLength(1);
  });
});
