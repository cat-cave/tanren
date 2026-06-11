// WS-A PR-4 wiring (walker-jj-local-integration-design.md §2.1, §4): `prepareRunWorkspace`
// chooses between the LEGACY single-ref clone and the jj-LOCAL base bootstrap purely on
// (`WALKER_JJ_LOCAL_BASE` on) AND (a non-empty ancestor stack). This pins BOTH branches:
//
//   FLAG-OFF / EMPTY STACK  ⇒ byte-identical to main: the `git clone --depth 1 --branch
//                             <targetBranch>` command IS issued; NO jj op; clone-HEAD = the
//                             clone's `git rev-parse HEAD`; NO `bootstrappedBaseRevision`.
//   FLAG-ON + NON-EMPTY     ⇒ the bootstrap path: NO legacy `git clone --branch`; the jj
//                             multi-ref assembly IS driven over the run's OWN runner; the
//                             clone-HEAD = the assembled head; `bootstrappedBaseRevision` =
//                             the LOCAL assembly bookmark (the conflict resolver's base).
//
// The flag-ON case drives the REAL `JjWorkspaceVcsCore` over a command-dispatching
// substrate (jj sha reads → 40-hex shas, the conflict probe → "clean") so the wiring is
// exercised end-to-end WITHOUT a real jj/runner — the assembly MECHANICS themselves are
// already pinned by `ancestorStackAssembly.conformance.test.ts` over real jj.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import { bootstrapLocalIntegrationRef } from "../src/engine/dag/jjLocalBootstrap.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

/** A successful command result carrying the given stdout. */
function out(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

const CLONE_HEAD = "c".repeat(40);
const ASSEMBLED_HEAD = "a".repeat(40);
const MEMBER_SHA = "b".repeat(40);
const TREE_HASH = "d".repeat(40);
const WORKSPACE_PATH = "/workspace/runs/run_dep/repo";

function unusedHttp(): GitHubHttpClient {
  return {
    request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
      throw new Error(`no GitHub HTTP expected in this unit path: ${req.method} ${req.path}`);
    },
  };
}

/**
 * A command-dispatching substrate: records every command, and returns the stdout each
 * step parses. The jj `commit_id` template + `git rev-parse` reads return 40-hex shas;
 * the conflict probe template returns a CLEAN line (so the assembly stays clean); every
 * other op returns empty. The legacy `git clone --branch` (when it runs) returns the
 * clone HEAD. This lets the REAL JjWorkspaceVcsCore drive the assembly with no real jj.
 */
class DispatchingSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const cmd = command.command;
    // The conflict probe (`change_id ++ ... if(conflict, "conflicted", "clean")`) ⇒ CLEAN.
    if (cmd.includes("conflicted") && cmd.includes("clean")) return out("change0\tclean");
    // The integration bookmark / run-branch head reads (`-T 'commit_id'`) ⇒ the assembled head.
    if (cmd.includes("commit_id")) return out(ASSEMBLED_HEAD);
    // The per-member pristine head read (`<branch>@origin`) ⇒ a member sha (the conflict
    // probe + commit_id branches already returned above; this is the bare `jj log` read in
    // jjLocalIntegration's readBookmarkSha for `<branch>@origin`). commit_id covers it.
    if (cmd.includes("@origin")) return out(MEMBER_SHA);
    // The tree-hash read (`git rev-parse <sha>^{tree}`) ⇒ a tree hash.
    if (cmd.includes("rev-parse") && cmd.includes("^{tree}")) return out(TREE_HASH);
    // The legacy single-ref clone's trailing `git rev-parse HEAD` ⇒ the clone HEAD.
    if (cmd.includes("git clone") || cmd.includes("rev-parse HEAD")) return out(CLONE_HEAD);
    return out("");
  }
}

function makeContext(overrides: Partial<PlannerRunContext> = {}): PlannerRunContext {
  return {
    runId: "run_dep",
    specId: "spec_dep",
    projectId: "project_dep",
    repoUrl: "https://github.com/cat-cave/dep-fixture",
    targetBranch: "main",
    runBranch: "tanren/run_dep",
    specTitle: "t",
    specDescription: "d",
    acceptanceCriteria: [],
    runnerImage: "image",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "",
    ...overrides,
  };
}

function makeInput(ssh: CommandSubstrate, context: PlannerRunContext): RunPlannerLoopInput {
  return {
    ssh,
    secrets: new FakeSecretStore(),
    vcsProvider: vcsProviderOver(unusedHttp()),
    context,
    timeoutMs: 500,
    bootstrapCommand: "true",
    runBootstrap: async () => {},
    commitBootstrap: async () => "",
  } as unknown as RunPlannerLoopInput;
}

const STACK: AncestorStack = [
  { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "" },
  { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "" },
];

function ranLegacyClone(ssh: DispatchingSsh): boolean {
  return ssh.commands.some((c) => c.command.command.includes("git clone --depth 1 --branch"));
}
function ranJj(ssh: DispatchingSsh): boolean {
  return ssh.commands.some((c) => c.command.command.includes("jj "));
}

describe("prepareRunWorkspace — WALKER_JJ_LOCAL_BASE base-bootstrap wiring", () => {
  const KEY = "WALKER_JJ_LOCAL_BASE";
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[KEY];
    else process.env[KEY] = prior;
  });

  it("FLAG OFF (=0 break-glass) + non-empty stack ⇒ the LEGACY single-ref clone", async () => {
    process.env[KEY] = "0";
    const ssh = new DispatchingSsh();
    const prepared = await prepareRunWorkspace(
      makeInput(ssh, makeContext({ ancestorStack: STACK })),
      target,
      WORKSPACE_PATH,
    );
    // The legacy `git clone --depth 1 --branch <targetBranch>` ran; NO jj assembly.
    expect(ranLegacyClone(ssh)).toBe(true);
    expect(ranJj(ssh)).toBe(false);
    expect(prepared.cloneHeadSha).toBe(CLONE_HEAD);
    // No locally-assembled base ⇒ the conflict resolver keeps `${targetBranch}@origin`.
    expect(prepared.bootstrappedBaseRevision).toBeUndefined();
  });

  it("FLAG ON + EMPTY stack ⇒ still the LEGACY clone (a non-speculative run is unchanged)", async () => {
    process.env[KEY] = "1";
    const ssh = new DispatchingSsh();
    // No ancestorStack on the context ⇒ resolveAncestorStack yields an empty stack.
    const prepared = await prepareRunWorkspace(makeInput(ssh, makeContext()), target, WORKSPACE_PATH);
    expect(ranLegacyClone(ssh)).toBe(true);
    expect(ranJj(ssh)).toBe(false);
    expect(prepared.cloneHeadSha).toBe(CLONE_HEAD);
    expect(prepared.bootstrappedBaseRevision).toBeUndefined();
  });

  it("FLAG ON + non-empty stack ⇒ the jj-LOCAL bootstrap: assembled head + the local base bookmark", async () => {
    process.env[KEY] = "1";
    const ssh = new DispatchingSsh();
    const prepared = await prepareRunWorkspace(
      makeInput(ssh, makeContext({ ancestorStack: STACK })),
      target,
      WORKSPACE_PATH,
    );
    // The bootstrap path: NO legacy single-ref clone; the jj multi-ref assembly DID run.
    expect(ranLegacyClone(ssh)).toBe(false);
    expect(ranJj(ssh)).toBe(true);
    // The clone-HEAD the writer replays onto is the ASSEMBLED head (not a remote clone HEAD).
    expect(prepared.cloneHeadSha).toBe(ASSEMBLED_HEAD);
    // The conflict resolver's merge-time base is the LOCAL assembly bookmark — a stable,
    // deterministic name derived from the run branch, NEVER a `tanren/integ` host ref.
    expect(prepared.bootstrappedBaseRevision).toBe(bootstrapLocalIntegrationRef("tanren/run_dep"));
    expect(prepared.bootstrappedBaseRevision?.startsWith("tanren/integ")).toBe(false);
    // The assembly ran on the RUN's OWN runner — every command targeted `target` (no
    // separate runless allocation), so the assembled checkout IS the writer-loop workspace.
    expect(ssh.commands.every((c) => c.target === target)).toBe(true);
    // The cwd-scoped jj ops (the assembly stack ops, NOT the dir-creating clone) run at the
    // run's `workspacePath`, so every downstream plain-`git` op finds the assembled checkout.
    const cwdScopedJj = ssh.commands.filter((c) => c.command.command.includes("jj ") && c.command.cwd !== undefined);
    expect(cwdScopedJj.length).toBeGreaterThan(0);
    expect(cwdScopedJj.every((c) => c.command.cwd === WORKSPACE_PATH)).toBe(true);
  });
});
