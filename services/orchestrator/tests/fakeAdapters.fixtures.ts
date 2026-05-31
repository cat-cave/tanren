// TEST-ONLY fixture. The fake answerer/writer adapters and the synthetic
// hello-world git workspace helpers live HERE — never in production source.
// Production code must not be able to construct a fake adapter (the
// no-fake-in-prod invariant): the runtime spec→PR run path injects REAL
// adapters via the adapter selector / phase-1 fixture seams. These fakes exist
// solely to drive conformance + cost + workspace behavior tests with
// deterministic, credential-free stand-ins.
//
// Moved out of:
//   - services/orchestrator/src/engine/providers/fake.ts
//   - services/orchestrator/src/engine/workspace/git.ts
// when the hello synthetic workflow was purged from the runtime.

import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/providers/answererSchemas.js";
import type { AnswererAdapter, Commit, WriterAdapter, WriterResult } from "../src/engine/providers/types.js";
import { quoteSshShellArg } from "../src/engine/ssh/command.js";
import { runWorkspaceSshCommand } from "../src/engine/workspace/index.js";

// Fake adapters are attributed as self-hosted billing. PROJECT_BRIEF §4.2
// treats fixed-fee local compute as a self-hosted endpoint with no per-call
// dollar basis, so the recorder writes cost_usd = NULL / cost_basis =
// 'unknown'. Token accounting still lands.
export const fakeSelfHostedAuthRef = "credential/self-hosted/tanren-fake";

export interface FakeWriterDependencies {
  ssh: SshSubstrate;
  target: SshTarget;
}

const authorEnv = "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'";
const fakeTokenUsage = {
  inputTokens: 32,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 16,
  reasoningOutputTokens: 0,
  totalTokens: 48,
};

export interface WorkspaceGitInput {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  timeoutMs: number;
}

export async function prepareGitWorkspace(input: WorkspaceGitInput): Promise<void> {
  const path = quoteSshShellArg(input.workspacePath);
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "prepare workspace",
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      `rm -rf ${path}`,
      `mkdir -p ${path}`,
      `cd ${path}`,
      "git init -b main",
      "git config user.name 'Tanren Fake Writer'",
      "git config user.email 'fake-writer@tanren.invalid'",
      "printf '%s\\n' '# Tanren workspace baseline' > README.md",
      "git add README.md",
      `${authorEnv} git commit -m baseline`,
    ].join(" && "),
  });
}

export async function runFakeWriterMutation(input: WorkspaceGitInput): Promise<void> {
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "fake writer mutation",
    timeoutMs: input.timeoutMs,
    cwd: input.workspacePath,
    command: [
      "set -eu",
      "printf '%s\\n' '# Hello from Tanren' '' 'hello world' > HELLO.md",
      "git add HELLO.md",
      `${authorEnv} git commit -m 'hello world'`,
    ].join(" && "),
  });
}

export async function captureGitMutation(input: WorkspaceGitInput): Promise<WriterResult> {
  const diff = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "capture git diff",
    timeoutMs: input.timeoutMs,
    cwd: input.workspacePath,
    command: "git diff --no-color HEAD~1..HEAD",
  });
  const log = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "capture git commit",
    timeoutMs: input.timeoutMs,
    cwd: input.workspacePath,
    command: "git log -1 --format='%H%x09%s' HEAD",
  });

  return {
    diff: diff.stdout,
    commits: [parseGitLogCommit(log.stdout)],
    exitReason: "completed",
    tokenUsage: fakeTokenUsage,
  };
}

export function parseGitLogCommit(stdout: string): Commit {
  const line = stdout.trimEnd().split("\n")[0] ?? "";
  const separator = line.indexOf("\t");
  if (separator === -1) {
    throw new Error("git commit capture did not include sha/message separator");
  }

  const sha = line.slice(0, separator);
  const message = line.slice(separator + 1);
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`git commit capture returned invalid sha: ${sha}`);
  }
  if (message === "") {
    throw new Error("git commit capture returned an empty commit message");
  }
  return { sha, message };
}

export const fakePlanner: AnswererAdapter<PlanAnswer> = {
  kind: "answerer",
  cli: "fake",
  authRef: fakeSelfHostedAuthRef,
  async runAnswerer() {
    return {
      subtasks: [
        {
          title: "Return hello-world status",
          acceptanceCriteria: ["The orchestrator persists a completed synthetic run"],
        },
      ],
    };
  },
};

export function createFakeWriter(dependencies: FakeWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "fake",
    authRef: fakeSelfHostedAuthRef,
    async runWriter(opts): Promise<WriterResult> {
      const input = {
        ssh: dependencies.ssh,
        target: dependencies.target,
        workspacePath: opts.workspace,
        timeoutMs: opts.timeoutMs,
      };
      await runFakeWriterMutation(input);
      return await captureGitMutation(input);
    },
  };
}

export const fakeChecker: AnswererAdapter<CheckAnswer> = {
  kind: "answerer",
  cli: "fake",
  authRef: fakeSelfHostedAuthRef,
  async runAnswerer() {
    return {
      done: true,
      reason: "Synthetic writer output satisfies the hello-world criteria.",
      suggested_fixes: null,
    };
  },
};

export const fakeAuditor: AnswererAdapter<AuditAnswer> = {
  kind: "answerer",
  cli: "fake",
  authRef: fakeSelfHostedAuthRef,
  async runAnswerer() {
    return {
      verified: true,
      criteria_status: {
        criteria: [
          {
            criterion: "The orchestrator persists a completed synthetic run",
            satisfied: true,
            reason: "The structured checker accepted the writer output.",
          },
        ],
      },
      reason: "All hello-world checks completed.",
    };
  },
};
