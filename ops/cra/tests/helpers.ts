import type { CraConfig } from "../src/config.js";

export function testConfig(overrides: Partial<CraConfig> = {}): CraConfig {
  const base: CraConfig = {
    repository: "cat-cave/tanren",
    repositoryRoot: "/tmp/cra-repository",
    baseBranch: "main",
    rubricVersion: "2026-07-22",
    github: {
      appId: 123,
      installationId: 456,
      expectedLogin: "trevor-workstation[bot]",
      privateKeyPath: "/tmp/cra-key.pem",
    },
    commands: { gh: "gh", git: "git", flock: "flock", containerRuntime: "docker" },
    isolation: {
      worktreeRoot: "/tmp/cra-worktrees",
      image: "localhost/craspec_worker:latest",
      timeoutMs: 30_000,
      memory: "256m",
      cpus: 1,
      pidsLimit: 64,
    },
    audit: {
      command: "cra-audit-worker",
      args: [],
      modelFamily: "grok",
      timeoutMs: 30_000,
      verificationCommand: { executable: "just", args: ["fast-check"] },
      deletionGate: { liveLineThreshold: 200 },
    },
    timing: { pollSeconds: 60, jitterSeconds: 10, inactivityDays: 7, reminderDays: [3, 6] },
  };
  return { ...base, ...overrides };
}

export const firstSha = "1".repeat(40);
export const secondSha = "2".repeat(40);
