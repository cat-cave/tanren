// Wave-2 / Slice P-B behavior tests (tanren-owns-the-engine.md §0, §6): the engine's
// live forge-UI WRITES now route through `SafeVisibilityProjection` (never block) and
// the engine's code READS route through the host-neutral `CodeHost` seam.
//
// Two behaviors are pinned:
//   (a) VisibilityProjection-NEVER-BLOCKS — a forge publish that THROWS yields a
//       `ProjectionOutcome.failed`, and the engine's RECORDED outcome is BYTE-IDENTICAL
//       whether the projection succeeds or fails. We assert this on the real
//       `publishGateVerdictBestEffort` call site: the merge-relevant signal it returns
//       (it never throws) is identical, and the only difference is a best-effort
//       `gate.publish_failed` NOTE on failure — never a changed decision.
//   (b) CodeHost READ substitution returns the SAME data the old provider path did —
//       proven on the `VcsProviderCodeHost` read adapter (the live percolation head-sha
//       site) AND on the real `GitHubCodeHost` over the existing github fake transport.
//
// Fixtures (the in-memory VcsProvider + a scripted github transport) are TEST FIXTURES
// — they live HERE under tests/, never in src/.

import { describe, expect, it } from "vitest";
import { InMemoryVcsProvider } from "./fakes/inMemoryVcsProvider.js";
import { CONFORMANCE_PRESENT_FILE } from "./vcsProviderConformance.js";
import { GitHubCodeHost } from "../../src/engine/providers/githubCodeHost.js";
import { buildProjectHostSeams } from "../../src/engine/providers/hostFactory.js";
import { VcsProviderCodeHost } from "../../src/engine/providers/vcsProviderCodeHost.js";
import { publishGateVerdictBestEffort } from "../../src/engine/workflow/gate/publishGateVerdictBestEffort.js";
import type { GateOutcome } from "../../src/engine/workflow/gate/runGateForWhen.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";
import type { PublishStatusInput, ResolvedVcsToken } from "../../src/engine/contracts/vcsProvider.js";

const REPO = { owner: "cat-cave", name: "apex" } as const;
const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function fakeToken(): ResolvedVcsToken {
  return { token: "ghp_test", source: "static", refresh: async () => "ghp_test" };
}

const PASSED_OUTCOME: GateOutcome = {
  passed: true,
  results: [{ passed: true, tier: "pre_merge", when: "pre_merge", steps: [] }],
};

/** Capture every `gate.publish_failed` emit so the test can assert the recorded note. */
interface RecordedEmit {
  when: string;
  headSha: string;
  passed: boolean;
  reason: string;
}

// The shared in-memory fake does not model `publishStatus` (nothing gates on it in
// its suite), so these test providers define it: one that SUCCEEDS (records the call)
// and one that THROWS (drives the projection's `failed` severance). `publishStatus`
// is not on the base class, so these are plain definitions (not `override`).

/** A VcsProvider whose `publishStatus` SUCCEEDS (records the call) — the happy path. */
class RecordingStatusVcsProvider extends InMemoryVcsProvider {
  readonly published: PublishStatusInput[] = [];
  async publishStatus(input: PublishStatusInput): Promise<void> {
    this.published.push(input);
  }
}

/** A VcsProvider whose `publishStatus` THROWS — drives the projection `failed` path. */
class ThrowingStatusVcsProvider extends InMemoryVcsProvider {
  async publishStatus(_input: PublishStatusInput): Promise<void> {
    throw new Error("forge status publish 403 (simulated)");
  }
}

describe("(a) VisibilityProjection never blocks — recorded decision is byte-identical", () => {
  async function runPublish(provider: InMemoryVcsProvider): Promise<RecordedEmit[]> {
    const emits: RecordedEmit[] = [];
    await publishGateVerdictBestEffort(
      { vcsProvider: provider, repo: { ...REPO }, token: fakeToken(), headSha: HEAD_SHA, outcome: PASSED_OUTCOME },
      "pre_merge",
      true,
      async (e) => {
        emits.push(e);
      },
    );
    return emits;
  }

  it("a SUCCEEDING gate publish mirrors the verdict and records NO publish-failed note", async () => {
    const provider = new RecordingStatusVcsProvider();
    const emits = await runPublish(provider);
    expect(emits).toEqual([]);
    // The projection published the tanren/gate commit status mirroring the passed verdict.
    expect(provider.published).toHaveLength(1);
    expect(provider.published[0]).toMatchObject({
      headSha: HEAD_SHA,
      context: "tanren/gate",
      state: "success",
    });
  });

  it("a THROWING gate publish is severed to a best-effort note and NEVER rejects", async () => {
    // The publish throws; the SafeVisibilityProjection captures it as `failed`. The
    // call resolves normally (no rejection) — the merge path proceeds on the internal
    // verdict exactly as on the success path. The ONLY difference is the best-effort note.
    const emits = await runPublish(new ThrowingStatusVcsProvider());
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({ when: "pre_merge", headSha: HEAD_SHA, passed: true });
    expect(emits[0]?.reason).toContain("403");
  });

  it("the merge-relevant return is identical (void, no throw) for success vs failure", async () => {
    // publishGateVerdictBestEffort returns void and never throws in EITHER case — so
    // the caller's control flow (proceed-to-merge on the internal verdict) is unchanged
    // by the projection outcome. That invariance IS the never-blocks guarantee.
    const okResult = await publishGateVerdictBestEffort(
      {
        vcsProvider: new RecordingStatusVcsProvider(),
        repo: { ...REPO },
        token: fakeToken(),
        headSha: HEAD_SHA,
        outcome: PASSED_OUTCOME,
      },
      "pre_merge",
      true,
      async () => {},
    );
    const failResult = await publishGateVerdictBestEffort(
      {
        vcsProvider: new ThrowingStatusVcsProvider(),
        repo: { ...REPO },
        token: fakeToken(),
        headSha: HEAD_SHA,
        outcome: PASSED_OUTCOME,
      },
      "pre_merge",
      true,
      async () => {},
    );
    // Both undefined; neither throws.
    expect(okResult).toBe(failResult);
  });

  it("COMPOUND failure: projection fails AND the failure-note emit throws → still resolves", async () => {
    // The real never-blocks guarantee. The projection rejects (403) AND the
    // best-effort `gate.publish_failed` note write ALSO rejects (a transient
    // event-store failure). publishGateVerdictBestEffort must STILL resolve — the
    // failure-reporting path cannot be allowed to halt a passing gate. The recorded
    // decision (proceed-to-merge on the internal verdict) is unchanged: this resolves
    // to void exactly as the all-success path does.
    let emitAttempted = false;
    const result = await publishGateVerdictBestEffort(
      {
        vcsProvider: new ThrowingStatusVcsProvider(),
        repo: { ...REPO },
        token: fakeToken(),
        headSha: HEAD_SHA,
        outcome: PASSED_OUTCOME,
      },
      "pre_merge",
      true,
      async () => {
        emitAttempted = true;
        throw new Error("event store unavailable (simulated)");
      },
    );
    // The note WAS attempted (the failure path ran)...
    expect(emitAttempted).toBe(true);
    // ...and it STILL resolved to void — never rejected.
    expect(result).toBeUndefined();
  });
});

/** A stateful github transport answering the git-ref read `GitHubCodeHost.fetchRef` issues. */
class FetchRefGitHubHttp implements GitHubHttpClient {
  constructor(private readonly shaByBranch: Record<string, string>) {}
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const path = input.path.split("?")[0] ?? input.path;
    const match = /\/git\/ref\/heads\/([^/]+)$/u.exec(path);
    if (input.method === "GET" && match) {
      const branch = decodeURIComponent(match[1] ?? "");
      const sha = this.shaByBranch[branch];
      return sha === undefined ? { status: 404, body: {} } : { status: 200, body: { object: { sha } } };
    }
    throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
  }
}

describe("(b) CodeHost read substitution returns the same data as the old provider path", () => {
  it("VcsProviderCodeHost.fetchRef matches the provider's readBranchHeadSha (live percolation read)", async () => {
    const provider = new InMemoryVcsProvider();
    const token = fakeToken();
    const branch = "feature/x";
    const viaProvider = await provider.readBranchHeadSha({ repo: { ...REPO }, branch, token });
    const codeHost = new VcsProviderCodeHost(provider, async () => token);
    const viaSeam = await codeHost.fetchRef({ repo: { ...REPO }, remoteBranch: branch });
    expect(viaSeam).toBe(viaProvider);
    expect(viaSeam).toBe("sha-feature/x");
  });

  it("VcsProviderCodeHost.readFile matches the provider's readFileOnBranch", async () => {
    const provider = new InMemoryVcsProvider();
    const token = fakeToken();
    const input = { repo: { ...REPO }, ref: "main", path: CONFORMANCE_PRESENT_FILE };
    const viaProvider = await provider.readFileOnBranch({ ...input, token });
    const codeHost = new VcsProviderCodeHost(provider, async () => token);
    const viaSeam = await codeHost.readFile(input);
    expect(viaSeam).toBe(viaProvider);
  });

  it("GitHubCodeHost.fetchRef reads the same ref the github transport serves", async () => {
    const http = new FetchRefGitHubHttp({ "feature/y": "cafe1234cafe1234cafe1234cafe1234cafe1234" });
    const codeHost = new GitHubCodeHost(http, async () => ({ token: "ghs_x" }));
    const present = await codeHost.fetchRef({ repo: { ...REPO }, remoteBranch: "feature/y" });
    const absent = await codeHost.fetchRef({ repo: { ...REPO }, remoteBranch: "no-such-branch" });
    expect(present).toBe("cafe1234cafe1234cafe1234cafe1234cafe1234");
    expect(absent).toBeUndefined();
  });
});

describe("hostFactory builds the per-project CodeHost + hardened SafeVisibilityProjection", () => {
  it("buildProjectHostSeams yields a working CodeHost read + a never-rejecting projection", async () => {
    const http = new FetchRefGitHubHttp({ "feature/z": "beadfeedbeadfeedbeadfeedbeadfeedbeadfeed" });
    // The factory reuses the EXISTING credential resolution — the same
    // `() => VcsProvider.resolveToken(creds)` closure the live path builds.
    const seams = buildProjectHostSeams(http, fakeToken);
    const sha = await seams.codeHost.fetchRef({ repo: { ...REPO }, remoteBranch: "feature/z" });
    expect(sha).toBe("beadfeedbeadfeedbeadfeedbeadfeedbeadfeed");
    // The hardened projection severs a failing publish into a `failed` outcome (the
    // FetchRefGitHubHttp transport throws on the status POST) — never rejects.
    const outcome = await seams.visibility.publishGate({
      repoFullName: "cat-cave/apex",
      headSha: HEAD_SHA,
      verdict: "passed",
      summary: "Native pre-merge gate passed.",
    });
    expect(outcome.kind).toBe("failed");
  });
});
