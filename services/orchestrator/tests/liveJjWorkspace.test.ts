// Unit proof for `buildLiveJjWorkspace`'s FAIL-CLOSED / no-leak error path
// (engine/providers/liveJjWorkspace.ts). Not gated — drives the factory with fakes (no
// live runner), so it runs in `just fast-check`.
//
// The BLOCKING guarantee under test: when the build fails AFTER a runner is allocated
// (here: the clone-token resolution throws) AND the cleanup `release()` ALSO fails (the
// runner ACTUALLY leaks), the thrown error must surface BOTH faults and NAME the leaked
// runnerId — a leaked runner is NEVER swallowed, even during error cleanup.

import { describe, expect, it, vi } from "vitest";
import {
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type RunnerAllocation,
} from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { VcsProvider } from "../src/engine/contracts/vcsProvider.js";
import { buildLiveJjWorkspace, type LiveJjWorkspaceDeps } from "../src/engine/providers/liveJjWorkspace.js";

const TARGET = sshRunnerHandle({
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:fake",
  identitySecretRef: "runner/identity",
});

/** Allocate succeeds; release behavior is injected (resolve = clean, reject = a real leak). */
class ScriptedAllocator implements Allocator {
  readonly releasedRunnerIds: string[] = [];
  constructor(private readonly releaseImpl: (runnerId: string) => Promise<void>) {}

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    return { runnerId: `runner_${request.runId}`, target: TARGET, imageSha: `${request.runnerImage}@sha256:fake` };
  }

  async release(runnerId: string): Promise<void> {
    this.releasedRunnerIds.push(runnerId);
    await this.releaseImpl(runnerId);
  }
}

const TOKEN_FAILURE = "resolveToken boom";

/** A VcsProvider whose `resolveToken` rejects — makes the build fail AFTER allocation. */
function tokenFailingVcsProvider(): VcsProvider {
  return new Proxy({} as VcsProvider, {
    get: (_t, prop) =>
      prop === "resolveToken"
        ? () => Promise.reject(new Error(TOKEN_FAILURE))
        : () => {
            throw new Error(`unexpected VcsProvider.${String(prop)}`);
          },
  });
}

function deps(allocator: Allocator): LiveJjWorkspaceDeps {
  return {
    facts: {
      orgId: "org_test",
      projectId: "proj_test",
      repoUrl: "https://github.com/o/r.git",
      // Non-empty static ref ⇒ the token IS resolved (so the failing resolveToken runs).
      githubCredentialRef: "github/static/token",
      identitySecretRef: "runner/identity",
    },
    allocator,
    ssh: new FakeCommandSubstrate(),
    secrets: new FakeSecretStore(),
    vcsProvider: tokenFailingVcsProvider(),
  };
}

describe("buildLiveJjWorkspace — fail-closed / no-leak error path", () => {
  it("build fails after allocation AND release leaks → throws an AggregateError naming both faults + the leaked runnerId", async () => {
    const leak = new Error("release exploded — runner leaked");
    const allocator = new ScriptedAllocator(() => Promise.reject(leak));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const thrown = await buildLiveJjWorkspace(deps(allocator)).then(
      () => {
        throw new Error("expected buildLiveJjWorkspace to throw");
      },
      (e: unknown) => e,
    );

    // BOTH faults are surfaced: the original build failure AND the runner leak.
    expect(thrown).toBeInstanceOf(AggregateError);
    const agg = thrown as AggregateError;
    expect(agg.errors).toHaveLength(2);
    expect((agg.errors[0] as Error).message).toBe(TOKEN_FAILURE);
    expect(agg.errors).toContain(leak);
    // The leaked runnerId is NAMED so the caller can act on the leak.
    expect(agg.message).toContain("runner_run_live_jj_");
    // release() WAS attempted (the cleanup ran) and the leak was logged LOUDLY.
    expect(allocator.releasedRunnerIds).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("build fails after allocation but release SUCCEEDS → re-throws ONLY the original build error (no leak)", async () => {
    const allocator = new ScriptedAllocator(() => Promise.resolve());

    const thrown = await buildLiveJjWorkspace(deps(allocator)).then(
      () => {
        throw new Error("expected buildLiveJjWorkspace to throw");
      },
      (e: unknown) => e,
    );

    // A clean cleanup release ⇒ the original build error propagates UNWRAPPED (not an
    // AggregateError — there is no leak to report).
    expect(thrown).not.toBeInstanceOf(AggregateError);
    expect((thrown as Error).message).toBe(TOKEN_FAILURE);
    expect(allocator.releasedRunnerIds).toHaveLength(1);
  });
});
