// MERGE-SAFETY (finding #7): the on-runner conflict-resolution commit must attribute
// to Tanren's BOT login — NOT a `*@tanren.invalid` placeholder. A placeholder author
// maps to a GitHub `null` login → reviewMerge `assessExternalChange` keys it
// `<unknown>` → external → a strict-posture run BLOCKS its own PR (a dependent spec
// that hit a conflict in v23 would strand at merge). These tests drive the on-runner
// authored-commit path (the live jj workspace) with fakes and assert the bot identity
// (the resolved `<slug>[bot]` login + its canonical
// `<id>+<login>@users.noreply.github.com` noreply email) is the commit author — and is
// recognized as Tanren's by the external-change gate.

import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { CommandResult, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { assessExternalChange, tanrenIdentity } from "../src/engine/workflow/reviewMerge/governancePosture.js";
import { buildLiveJjWorkspace, type LiveJjWorkspaceDeps } from "../src/engine/providers/liveJjWorkspace.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import {
  CONFORMANCE_ACTOR_ID,
  CONFORMANCE_ACTOR_LOGIN,
  CONFORMANCE_ACTOR_NOREPLY_EMAIL,
} from "./conformance/vcsProviderConformance.js";

// §5a: the bot-push-identity resolution now runs through the standalone credential helpers
// off a REAL `GitHubVcsProvider`'s GitHub client. The transport serves the static-credential
// identity read (`GET /user`) returning the conformance actor, so the resolved bot login +
// canonical noreply email match `CONFORMANCE_ACTOR_*` exactly.
class ConformanceUserGitHubHttp implements GitHubHttpClient {
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (input.method === "GET" && input.path === "/user") {
      return { status: 200, body: { login: CONFORMANCE_ACTOR_LOGIN, id: Number(CONFORMANCE_ACTOR_ID) } };
    }
    throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
  }
}

/** Records every command the workspace mechanism runs so the test reads the clone/config. */
class RecordingSubstrate extends FakeCommandSubstrate {
  readonly commands: string[] = [];
  override async run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    return super.run(handle, command);
  }
}

const AUTHENTICATED_REF = "credential/github/dev";

describe("conflict-resolve bot identity (finding #7)", () => {
  it("live jj workspace: sets the BOT identity as the jj commit author (not tanren@local)", async () => {
    const ssh = new RecordingSubstrate();
    // The static credential the run resolves its push token (and bot identity) from.
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: AUTHENTICATED_REF, value: "ghp_fake_static" });
    const deps: LiveJjWorkspaceDeps = {
      facts: {
        orgId: "org_x",
        projectId: "project_x",
        repoUrl: "https://github.com/o/r",
        githubCredentialRef: AUTHENTICATED_REF,
        identitySecretRef: "secret/runner/identity",
      },
      allocator: new FakeAllocator(),
      ssh,
      secrets,
      vcsProvider: vcsProviderOver(new ConformanceUserGitHubHttp()),
      timeoutMs: 1000,
    };
    const live = await buildLiveJjWorkspace(deps);
    // Open a workspace so the jj identity config is issued over the substrate.
    await live.core.openWorkspace({ repoUrl: "https://github.com/o/r", baseBranch: "main", path: "/ws/repo" });
    await live.release();

    const identityCmd = ssh.commands.find((c) => c.includes("jj config set --repo user.email"));
    expect(identityCmd).toBeDefined();
    // BOT-ATTRIBUTED: the jj author is the resolved bot login + noreply, so a commit jj
    // exports + pushes onto a PR is recognized as Tanren's — not `tanren@local`.
    expect(identityCmd).toContain(`jj config set --repo user.name '${CONFORMANCE_ACTOR_LOGIN}'`);
    expect(identityCmd).toContain(`jj config set --repo user.email '${CONFORMANCE_ACTOR_NOREPLY_EMAIL}'`);
    expect(identityCmd).not.toContain("tanren@local");
  });

  it("a bot-attributed resolution commit is NOT external (the merge-safety gate recognizes it)", () => {
    // The PR's commit authors, as the external-change gate sees them (lower-cased GitHub
    // logins). A conflict-resolution commit authored by the bot noreply email maps to the
    // bot LOGIN; the gate's Tanren-identity set carries that same login.
    const identity = tanrenIdentity([CONFORMANCE_ACTOR_LOGIN]);
    const botAuthored = assessExternalChange({ logins: [CONFORMANCE_ACTOR_LOGIN] }, identity);
    expect(botAuthored.hasExternalChange).toBe(false);
    expect(botAuthored.externalLogins).toEqual([]);

    // Contrast: the OLD placeholder mapped to a `null`/empty login → keyed `<unknown>` →
    // external → it would BLOCK Tanren's own PR. This is exactly the bug finding #7 fixes.
    const placeholderAuthored = assessExternalChange({ logins: [""] }, identity);
    expect(placeholderAuthored.hasExternalChange).toBe(true);
    expect(placeholderAuthored.externalLogins).toEqual(["<unknown>"]);
  });
});
