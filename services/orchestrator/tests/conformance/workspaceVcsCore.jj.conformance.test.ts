// Drives the FROZEN WorkspaceVcsCore conformance suite
// (workspaceVcsCoreConformance.ts, tanren-owns-the-engine.md §2) against the REAL,
// PREFERRED `JjWorkspaceVcsCore` over an ACTUAL `jj` process (the
// LocalCommandSubstrate) + a real local git fixture jj clones — NOT the in-memory
// fake. This proves jj's native first-class-conflict guarantees end to end: a
// conflicting rebase SUCCEEDS + records the conflict IN the commit, an ancestor
// resolution auto-PROPAGATES to descendants on restack, export REFUSES a conflicted
// ref, `jj op undo` reverts.
//
// ENV-GATED (skip-with-loud-reason): `jj` is NOT yet in the orchestrator test image
// / `just fast-check` path — only the runner Dockerfile installs it (Wave-2 wires
// the live engine onto jj). So when `jj` is absent we SKIP loudly rather than fail
// `just fast-check`, exactly like the RLS/SSH smoke gates. The git sibling
// (workspaceVcsCore.git.conformance.test.ts) is the always-on real-backend proof; set
// `TANREN_JJ_CONFORMANCE=1` (with jj installed) to run this one.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import type { JjRefResolver, JjWorkingEdit } from "../../src/engine/providers/jjWorkspaceVcsCore.js";
import type {
  OpenWorkspaceInput,
  WorkspaceHandle,
  WorkspaceVcsCore,
} from "../../src/engine/contracts/workspaceVcsCore.js";
import { JjWorkspaceVcsCore } from "../../src/engine/providers/jjWorkspaceVcsCore.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./fakes/localCommandSubstrate.js";
import { makeGitFixture } from "./fakes/gitWorkspaceFixtureRepo.js";
import { describeWorkspaceVcsCoreConformance } from "./workspaceVcsCoreConformance.js";

function jjInstalled(): boolean {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const RUN_JJ = process.env["TANREN_JJ_CONFORMANCE"] === "1" || jjInstalled();

// Map the suite's synthetic base tokens onto the jj clone's imported bookmarks (jj
// imports the git fixture's `conflict-base` / `clean-base` branches as bookmarks).
// `cloneSource` is overridden per-workspace below with the fixture origin path.
const jjRefResolver: JjRefResolver = {
  cloneSource: () => "",
  baseRevision: (baseSha) => {
    if (baseSha.startsWith("conflict-")) return "conflict-base";
    if (baseSha.startsWith("clean-")) return "clean-base";
    return baseSha;
  },
};

const jjWorkingEdit: JjWorkingEdit = (message) => [
  `mkdir -p src`,
  `printf %s ${shellQuote(`ours:${message}\n`)} > src/conflicted.ts`,
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Remaps the harness's fixed `/w` path onto a fresh temp dir AND points the clone at
// the per-workspace fixture origin. Pure test plumbing.
class PathRemappingJjCore implements WorkspaceVcsCore {
  constructor(
    private readonly inner: JjWorkspaceVcsCore,
    private readonly origin: string,
    private readonly scratchRoot: string,
  ) {}

  async openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceHandle> {
    const path = mkdtempSync(join(this.scratchRoot, "ws-"));
    return this.inner.openWorkspace({ ...input, repoUrl: this.origin, path });
  }
  branch(ws: WorkspaceHandle, name: string, atBranch?: string): Promise<void> {
    return this.inner.branch(ws, name, atBranch);
  }
  checkout(ws: WorkspaceHandle, branch: string): Promise<void> {
    return this.inner.checkout(ws, branch);
  }
  commit(ws: WorkspaceHandle, message: string): ReturnType<WorkspaceVcsCore["commit"]> {
    return this.inner.commit(ws, message);
  }
  rebaseOnto(ws: WorkspaceHandle, branch: string, baseSha: string): ReturnType<WorkspaceVcsCore["rebaseOnto"]> {
    return this.inner.rebaseOnto(ws, branch, baseSha);
  }
  resolveConflict(
    input: Parameters<WorkspaceVcsCore["resolveConflict"]>[0],
  ): ReturnType<WorkspaceVcsCore["resolveConflict"]> {
    return this.inner.resolveConflict(input);
  }
  restackDescendants(ws: WorkspaceHandle, branch: string): ReturnType<WorkspaceVcsCore["restackDescendants"]> {
    return this.inner.restackDescendants(ws, branch);
  }
  exportCleanGitRef(ws: WorkspaceHandle, branch: string): ReturnType<WorkspaceVcsCore["exportCleanGitRef"]> {
    return this.inner.exportCleanGitRef(ws, branch);
  }
  opUndo(ws: WorkspaceHandle): Promise<void> {
    return this.inner.opUndo(ws);
  }
}

// ENV-GATE (no `if`/`.skip` literals — the repo's `describe.skipIf` idiom): when jj
// is absent the whole suite is SKIPPED loudly (vitest prints this skipped describe);
// the git sibling is the always-on real-backend proof. `jj` is installed only in the
// runner image / locally; set TANREN_JJ_CONFORMANCE=1 (with jj on PATH) to run it.
describe.skipIf(!RUN_JJ)("WorkspaceVcsCore real-jj conformance (env-gated on jj)", () => {
  describeWorkspaceVcsCoreConformance("JjWorkspaceVcsCore (real jj)", {
    make: (): WorkspaceVcsCore => {
      const fixture = makeGitFixture();
      const scratch = mkdtempSync(join(tmpdir(), "tanren-jj-ws-"));
      const core = new JjWorkspaceVcsCore({
        substrate: new LocalCommandSubstrate(),
        target: LOCAL_HANDLE,
        timeoutMs: 60_000,
        refResolver: jjRefResolver,
        workingEdit: jjWorkingEdit,
      });
      return new PathRemappingJjCore(core, fixture.originPath, scratch);
    },
  });
});
