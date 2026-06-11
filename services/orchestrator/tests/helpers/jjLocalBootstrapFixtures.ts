// Shared TEST FIXTURES for the jj-local dependent bootstrap suites (WS-A PR-8 eager_base
// node UPSERT + WS-A PR-8c ancestor_stack head-sha write-back). Extracted so each suite
// stays under the 500-line / 5-class caps while sharing the one command-dispatching SSH
// substrate, the run context/input builders, and the RLS-DB plumbing helpers. Fixtures
// only — never imported by src/.

import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../../src/engine/contracts/commandSubstrate.js";
import type {
  BootstrapStackHeadShaWriteBack,
  EagerBaseNodeUpsert,
} from "../../src/engine/workflow/plannerRunJjLocalBootstrap.js";
import type { AncestorStack } from "../../src/engine/dag/ancestorStack.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../../src/engine/workflow/plannerRun.js";
import { vcsProviderOver } from "./vcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";

export const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

export function out(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

export const ASSEMBLED_HEAD = "a".repeat(40);
export const MEMBER_SHA = "b".repeat(40);
export const TREE_HASH = "d".repeat(40);
export const CLONE_HEAD = "c".repeat(40);
export const WORKSPACE_PATH = "/workspace/runs/run_dep/repo";
export const RUN_BRANCH = "tanren/run_dep";

function unusedHttp(): GitHubHttpClient {
  return {
    request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
      throw new Error(`no GitHub HTTP expected in this unit path: ${req.method} ${req.path}`);
    },
  };
}

// A command-dispatching substrate identical in spirit to plannerRunWorkspaceJjLocalBase's:
// the jj `commit_id` reads → the assembled head, the conflict probe → CLEAN, the tree read →
// a tree hash, the legacy clone → the clone HEAD. The REAL JjWorkspaceVcsCore drives the
// assembly with no real jj/runner.
export class DispatchingSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const cmd = command.command;
    if (cmd.includes("conflicted") && cmd.includes("clean")) return out("change0\tclean");
    // The per-member PRISTINE head read (`jj log -r '<branch>@origin' -T 'commit_id'`) ⇒ a
    // member sha — checked BEFORE the bare `commit_id` branch (both use the commit_id
    // template; the `@origin` revset disambiguates the member read from the head read).
    if (cmd.includes("@origin")) return out(MEMBER_SHA);
    if (cmd.includes("commit_id")) return out(ASSEMBLED_HEAD);
    if (cmd.includes("rev-parse") && cmd.includes("^{tree}")) return out(TREE_HASH);
    if (cmd.includes("git clone") || cmd.includes("rev-parse HEAD")) return out(CLONE_HEAD);
    return out("");
  }
}

export function makeContext(overrides: Partial<PlannerRunContext> = {}): PlannerRunContext {
  return {
    runId: "run_dep",
    specId: "spec_dep",
    projectId: "project_dep",
    orgId: "org_dep",
    repoUrl: "https://github.com/cat-cave/dep-fixture",
    targetBranch: "main",
    runBranch: RUN_BRANCH,
    specTitle: "t",
    specDescription: "d",
    acceptanceCriteria: [],
    runnerImage: "image",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "",
    ...overrides,
  };
}

export function makeInput(
  ssh: CommandSubstrate,
  context: PlannerRunContext,
  eagerBaseNodeUpsert?: EagerBaseNodeUpsert,
  bootstrapStackHeadShaWriteBack?: BootstrapStackHeadShaWriteBack,
): RunPlannerLoopInput {
  return {
    ssh,
    secrets: new FakeSecretStore(),
    vcsProvider: vcsProviderOver(unusedHttp()),
    context,
    timeoutMs: 500,
    bootstrapCommand: "true",
    runBootstrap: async () => {},
    commitBootstrap: async () => "",
    ...(eagerBaseNodeUpsert !== undefined && { eagerBaseNodeUpsert }),
    ...(bootstrapStackHeadShaWriteBack !== undefined && { bootstrapStackHeadShaWriteBack }),
  } as unknown as RunPlannerLoopInput;
}

export const STACK: AncestorStack = [
  { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "" },
  { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "" },
];

// --- RLS-DB plumbing (gated behind TANREN_RLS_DB_TEST=1) shared by the DB layers --------

export const RLS_DB_ENABLED = process.env["TANREN_RLS_DB_TEST"] === "1";
export const SYSTEM_ROLE = "tanren_system";
export const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";
export const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
export const APP_ROLE = "tanren_app";
export const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

export function dbName(prefix: string): string {
  return `tanren_${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
export function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
