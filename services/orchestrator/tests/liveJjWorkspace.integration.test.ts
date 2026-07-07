// Wave-3 Slice A1 — the GATED live proof for `buildLiveJjWorkspace`
// (engine/providers/liveJjWorkspace.ts): the literal "a real jj rebase resolves a
// conflict in-place against a REAL allocated runner" end-to-end. It allocates a runner,
// seeds a real git fixture repo ON THE RUNNER over the live SSH `CommandSubstrate`,
// `jj git clone`s it through the factory's `JjWorkspaceVcsCore`, then runs
// openWorkspace → branch → commit → rebaseOnto(a CONFLICTING base) → resolveConflict →
// exportCleanGitRef, and asserts the exported ref is CLEAN (no conflict markers).
//
// WHY this is the A1 risk that needed isolating: the jj-CLI semantics are already
// conformance-pinned against real jj (tests/conformance/workspaceVcsCore.jj.conformance
// .test.ts) over the LOCAL substrate. The NEW surface A1 introduces is ONLY
// runner-allocation + SSH-clone + clone-credential — so this test exercises EXACTLY that
// new surface (the factory) against a real runner over real SSH, while reusing the same
// conflicting-base fixture shape the conformance suite proved.
//
// ENV-GATE (opt-in, like ssh.integration.test.ts): the test runs ONLY when
//   TANREN_LIVE_RUNNER_TEST=1
// AND the SSH runner reach is provided:
//   TANREN_SSH_HOST  (default 127.0.0.1)
//   TANREN_SSH_PORT  (default 22)
//   TANREN_SSH_USER  (default tanren)
//   TANREN_SSH_HOST_FINGERPRINT  (required — the SHA256 host-key fingerprint)
//   TANREN_SSH_KEY_PATH          (required — path to the SSH private key)
// When the gate is off the whole suite SKIPS (so `just fast-check` stays green); when on
// it runs the REAL path. The runner must have `jj` + `git` on PATH (the runner image does).
//
// HOW TO RUN (against a reachable SSH runner with jj+git installed):
//   TANREN_LIVE_RUNNER_TEST=1 \
//   TANREN_SSH_HOST=<host> TANREN_SSH_PORT=22 TANREN_SSH_USER=<user> \
//   TANREN_SSH_HOST_FINGERPRINT=SHA256:<fp> TANREN_SSH_KEY_PATH=/path/to/key \
//   pnpm --filter @tanren/orchestrator vitest run tests/liveJjWorkspace.integration.test.ts

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type RunnerAllocation,
  type RunnerHandle,
} from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";
import { runWorkspaceSshCommand } from "../src/engine/workspace/ssh.js";
import { quoteSshShellArg } from "../src/engine/ssh/command.js";
import { buildLiveJjWorkspace } from "../src/engine/providers/liveJjWorkspace.js";

// Opt-in gate (same discipline as ssh.integration.test.ts): the suite SKIPS unless
// TANREN_LIVE_RUNNER_TEST=1, so `just fast-check` stays green; the title carries the loud
// reason. When on, `requiredEnv` LOUDLY fails if the SSH runner reach is incomplete.
const describeLive = process.env.TANREN_LIVE_RUNNER_TEST === "1" ? describe : describe.skip;

const IDENTITY_REF = "runner/live-jj/identity";

describeLive(
  "buildLiveJjWorkspace — real jj rebase resolves a conflict in-place on a real runner (SKIPPED unless TANREN_LIVE_RUNNER_TEST=1)",
  () => {
    it("allocates a runner, clones a real fixture over SSH, and exports a CLEAN resolved ref", async () => {
      const keyPath = requiredEnv("TANREN_SSH_KEY_PATH");
      const fingerprint = requiredEnv("TANREN_SSH_HOST_FINGERPRINT");

      const secrets = new FakeSecretStore();
      await secrets.put({ ref: IDENTITY_REF, value: await readFile(keyPath, "utf8") });

      const ssh = new SshCommandSubstrate(secrets);
      const target = sshRunnerHandle({
        host: process.env.TANREN_SSH_HOST ?? "127.0.0.1",
        port: Number(process.env.TANREN_SSH_PORT ?? "22"),
        username: process.env.TANREN_SSH_USER ?? "tanren",
        hostKeyFingerprint: fingerprint,
        identitySecretRef: IDENTITY_REF,
      });

      // A minimal env-driven allocator pinned to the configured host — a TEST FIXTURE that
      // satisfies the `Allocator` contract (allocate → release) so the factory drives its
      // real allocation thread without the full runners-table mirror. The factory's runless
      // allocation request shape is what is under test, not the backend's persistence.
      const allocator = new SingleHostAllocator(target);

      // Seed a REAL git fixture repo ON THE RUNNER over the live SSH substrate: a `main`
      // base, a `conflict-base` branch that edits the SAME file the feature commit edits
      // (a genuine 3-way conflict). jj clones this local path — a real fixture over real SSH.
      const repoUrl = await seedConflictFixtureOnRunner(ssh, target);

      // The GitHub transport MUST NOT be reached for an anonymous (local-path) clone — pass a
      // client that throws if it ever is, proving the anonymous credential path is taken.
      const githubHttp = throwingGitHubHttp();

      const live = await buildLiveJjWorkspace({
        facts: {
          orgId: "org_live-jj_test",
          projectId: "proj_live-jj_test",
          repoUrl,
          // Anonymous local-path clone (no installation + no static ref).
          githubCredentialRef: "",
          identitySecretRef: IDENTITY_REF,
        },
        allocator,
        ssh,
        secrets,
        githubHttp,
        timeoutMs: 120_000,
      });

      expect(live.tokenSource).toBe("anonymous");
      expect(live.target).toBe(target);

      try {
        // openWorkspace → branch → commit (edits the conflicted file) → rebaseOnto the
        // CONFLICTING base → resolveConflict (intent-preserving content) → exportCleanGitRef.
        const ws = await live.core.openWorkspace({
          repoUrl,
          baseBranch: "main",
          path: live.workspacePath,
        });
        await live.core.branch(ws, "feature", "main");

        // The feature commit edits the SAME path conflict-base edits → a real conflict.
        await runWorkspaceSshCommand(ssh, target, {
          label: "seed feature edit",
          cwd: live.workspacePath,
          timeoutMs: 120_000,
          command: ["set -eu", "mkdir -p src", "printf 'ours\\n' > src/conflicted.ts"].join(" && "),
        });
        await live.core.commit(ws, "feature edit on conflicted.ts");

        // FIRST-CLASS conflict: the rebase SUCCEEDS and RECORDS the conflict in the commit.
        const rebase = await live.core.rebaseOnto(ws, "feature", "conflict-base");
        expect(rebase.outcome).toBe("conflicted");
        expect(rebase.conflict).toBeDefined();
        const conflict = rebase.conflict;
        if (conflict === undefined) throw new Error("expected a recorded conflict");
        expect(conflict.paths).toContain("src/conflicted.ts");

        // Resolve IN-PLACE with the intent-preserving content (the never-discard guarantee).
        await live.core.resolveConflict({
          workspace: ws,
          branch: "feature",
          conflictId: conflict.conflictId,
          resolutions: [{ path: "src/conflicted.ts", content: "ours\ntheirs\n" }],
        });

        // exportCleanGitRef REFUSES a conflicted ref — a clean export proves the in-place
        // resolution stuck. Then read the exported ref's content back and assert NO markers.
        const exported = await live.core.exportCleanGitRef(ws, "feature");
        expect(exported.ref).toBe("refs/heads/feature");

        const content = await runWorkspaceSshCommand(ssh, target, {
          label: "read resolved file",
          cwd: live.workspacePath,
          timeoutMs: 120_000,
          command: ["set -eu", "cat src/conflicted.ts"].join(" && "),
        });
        expect(content.stdout).toContain("ours");
        expect(content.stdout).toContain("theirs");
        expect(content.stdout).not.toContain("<<<<<<<");
        expect(content.stdout).not.toContain(">>>>>>>");
        expect(content.stdout).not.toContain("=======");
      } finally {
        await live.release();
      }
    }, 300_000);
  },
);

/** A single pre-provisioned SSH host as an `Allocator` — TEST FIXTURE for the gated test. */
class SingleHostAllocator implements Allocator {
  readonly taxonomy = "fixed_pool" as const;
  constructor(private readonly target: RunnerHandle) {}

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    return {
      runnerId: `runner_${request.runId}`,
      target: this.target,
      imageSha: `${request.runnerImage}@sha256:live-jj`,
    };
  }

  async release(): Promise<void> {}
}

/**
 * Seed a real git fixture repo on the runner (a bare origin + a `conflict-base` branch),
 * over the live SSH substrate, and return its runner-local path as the clone URL. Mirrors
 * the conformance fixture's conflict shape (same file edited on both sides).
 */
async function seedConflictFixtureOnRunner(ssh: CommandSubstrate, target: RunnerHandle): Promise<string> {
  const root = `/tmp/tanren-live-jj-fixture-${Date.now()}`;
  const seed = `${root}/seed`;
  const origin = `${root}/origin.git`;
  const q = quoteSshShellArg;
  await runWorkspaceSshCommand(ssh, target, {
    label: "seed git fixture",
    timeoutMs: 120_000,
    command: [
      "set -eu",
      `rm -rf ${q(root)}`,
      `mkdir -p ${q(seed)}`,
      `cd ${q(seed)}`,
      "git init --quiet --initial-branch=main",
      "git config user.name Fixture",
      "git config user.email fixture@local",
      "mkdir -p src",
      "printf 'base\\n' > src/conflicted.ts",
      "git add -A",
      "git commit --quiet -m base",
      // conflict-base: edits the SAME file the feature commit will edit → real conflict.
      "git checkout --quiet -b conflict-base",
      "printf 'theirs\\n' > src/conflicted.ts",
      "git add -A",
      "git commit --quiet -m 'conflict base edit'",
      "git checkout --quiet main",
      `git clone --quiet --bare ${q(seed)} ${q(origin)}`,
    ].join(" && "),
  });
  return origin;
}

/** A `GitHubHttpClient` whose request throws — proves the anonymous clone never reaches GitHub. */
function throwingGitHubHttp(): GitHubHttpClient {
  return {
    async request() {
      throw new Error("the GitHub transport must not be invoked for an anonymous local-path clone");
    },
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when TANREN_LIVE_RUNNER_TEST=1`);
  }
  return value;
}
