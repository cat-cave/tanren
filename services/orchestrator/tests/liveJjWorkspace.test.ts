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
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { buildLiveJjWorkspace, type LiveJjWorkspaceDeps } from "../src/engine/providers/liveJjWorkspace.js";

// §5a: credential resolution runs through the standalone `resolveVcsToken`/
// `resolveVcsActorIdentity` helpers over the run's shared GitHub HTTP client — so these
// tests inject a scripted GitHub transport directly (the `VcsProvider` interface is gone,
// PR-9). The clone token comes from the secret store via `resolveGithubToken`; the bot
// identity from the transport's `GET /user`.

/** A scripted GitHub transport serving the `GET /user` identity read the static path issues. */
class StaticUserGitHubHttp implements GitHubHttpClient {
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (input.method === "GET" && input.path === "/user") {
      return { status: 200, body: { login: "tanren-bot", id: 999 } };
    }
    throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
  }
}

/** A transport that rejects every request — never reached on the missing-secret failure path. */
class UnusedGitHubHttp implements GitHubHttpClient {
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
  }
}

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

// The missing-secret error `resolveGithubToken` raises when the static ref points at
// nothing — the credential-resolution failure that makes the build fail AFTER allocation.
const TOKEN_FAILURE = "missing GitHub credential ref: github/static/token";

/** The GitHub transport for the failing-credential path (never reached — the secret is absent). */
function tokenFailingGitHubHttp(): GitHubHttpClient {
  return new UnusedGitHubHttp();
}

function deps(allocator: Allocator): LiveJjWorkspaceDeps {
  return {
    facts: {
      orgId: "org_test",
      projectId: "proj_test",
      repoUrl: "https://github.com/o/r.git",
      // Non-empty static ref ⇒ the token IS resolved (so the failing resolution runs);
      // the secret store below has NO secret at this ref ⇒ resolution throws after alloc.
      githubCredentialRef: "github/static/token",
      identitySecretRef: "runner/identity",
    },
    allocator,
    ssh: new FakeCommandSubstrate(),
    // No secret at `github/static/token` ⇒ credential resolution fails AFTER allocation.
    secrets: new FakeSecretStore(),
    githubHttp: tokenFailingGitHubHttp(),
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

  it("release() is IDEMPOTENT — a second call (after the applier already released) is a no-op", async () => {
    // A SUCCESSFUL build (a static-only credential resolves clean) returns the workspace
    // + its `release`. The SAME closure is held by the applier (terminal publish/abort)
    // AND the wiring's fail-closed catch; a later resolver step throwing must NOT
    // double-release the runner. Calling release() twice releases exactly once.
    const allocator = new ScriptedAllocator(() => Promise.resolve());
    const okSecrets = new FakeSecretStore();
    await okSecrets.put({ ref: "github/static/token", value: "ghp_fake" });
    const ws = await buildLiveJjWorkspace({
      ...deps(allocator),
      secrets: okSecrets,
      // A provider that resolves the static token cleanly (build SUCCEEDS this time).
      githubHttp: staticTokenGitHubHttp(),
    });

    await ws.release();
    await ws.release();

    // Exactly one allocator.release — the second call short-circuited (idempotent).
    expect(allocator.releasedRunnerIds).toHaveLength(1);
    expect(allocator.releasedRunnerIds[0]).toMatch(/^runner_run_live_jj_/u);
  });
});

/**
 * A GitHub transport that serves the static-credential identity read (`GET /user`) — so the
 * build SUCCEEDS: `resolveVcsToken` reads the static token from the secret store and
 * `resolveVcsActorIdentity` resolves the bot pushing identity (finding #7) off the SAME
 * credential, attributing the jj commit author.
 */
function staticTokenGitHubHttp(): GitHubHttpClient {
  return new StaticUserGitHubHttp();
}
