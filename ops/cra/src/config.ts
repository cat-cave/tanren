import { lstat, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { CRA_RUBRIC } from "./auditRubric.js";
import { assertOutsideRepository, resolveCraPaths, type CraPaths } from "./paths.js";

const commandSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "command contains NUL");
const durationSchema = z.number().int().positive();

export const craConfigSchema = z.strictObject({
  mode: z.enum(["shadow", "review", "merge"]).default("shadow"),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  repositoryRoot: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  rubricVersion: z.string().min(1),
  github: z.strictObject({
    appId: z.number().int().positive(),
    installationId: z.number().int().positive(),
    expectedLogin: z.string().min(1).default("trevor-workstation[bot]"),
    privateKeyPath: z.string().min(1),
  }),
  commands: z
    .strictObject({
      gh: commandSchema.default("gh"),
      git: commandSchema.default("git"),
      flock: commandSchema.default("flock"),
      containerRuntime: commandSchema.default("docker"),
    })
    .default({ gh: "gh", git: "git", flock: "flock", containerRuntime: "docker" }),
  isolation: z.strictObject({
    worktreeRoot: z.string().min(1).default("/scratch/worktrees/tanren/cra"),
    image: z.string().min(1),
    timeoutMs: durationSchema.default(900_000),
    memory: z
      .string()
      .regex(/^\d+[bkmg]$/iu)
      .default("4g"),
    cpus: z.number().positive().max(64).default(2),
    pidsLimit: z.number().int().positive().max(4096).default(512),
  }),
  // The deep adversarial audit worker is a CROSS-MODEL external CLI (like the grok
  // gate used to build this repo): a different model family from any contributor
  // and from the supervisor. It receives the structured audit context on stdin and
  // must emit the strict audit report on stdout. `modelFamily` is the audit worker's
  // own family and is checked against a known contributor family for independence.
  audit: z
    .strictObject({
      command: commandSchema.default("tanren-cra-audit"),
      args: z.array(commandSchema).default([]),
      modelFamily: z.string().min(1).default("grok"),
      timeoutMs: durationSchema.default(1_800_000),
      // The TRUSTED acceptance/verification command the supervisor itself runs in
      // the CRA-04 sandbox against the PR branch. It is config-sourced, NEVER
      // worker-supplied — a worker command can never confirm a gate. Its ground-truth
      // exit status is the acceptance signal.
      verificationCommand: z
        .strictObject({ executable: commandSchema, args: z.array(z.string()) })
        .default({ executable: "just", args: ["fast-check"] }),
      // Supervisor-computed deletion gate: net live-code deletion (deleted minus
      // added live lines) at or above this many lines blocks regardless of the
      // worker's accounting. Test deletions are gated separately (any net test
      // regression blocks).
      deletionGate: z
        .strictObject({ liveLineThreshold: z.number().int().positive() })
        .default({ liveLineThreshold: 100 }),
    })
    .default({
      command: "tanren-cra-audit",
      args: [],
      modelFamily: "grok",
      timeoutMs: 1_800_000,
      verificationCommand: { executable: "just", args: ["fast-check"] },
      deletionGate: { liveLineThreshold: 100 },
    }),
  timing: z
    .strictObject({
      pollSeconds: durationSchema.default(60),
      jitterSeconds: z.number().int().nonnegative().default(10),
      inactivityDays: durationSchema.default(7),
      reminderDays: z.tuple([durationSchema, durationSchema]).default([3, 6]),
    })
    .default({ pollSeconds: 60, jitterSeconds: 10, inactivityDays: 7, reminderDays: [3, 6] }),
  notification: z
    .strictObject({
      command: commandSchema.default("logger"),
      args: z.array(commandSchema).default(["--stderr", "--priority", "user.err", "--tag", "tanren-cra"]),
    })
    .default({
      command: "logger",
      args: ["--stderr", "--priority", "user.err", "--tag", "tanren-cra"],
    }),
});

export type CraConfig = z.infer<typeof craConfigSchema>;

export interface LoadedConfig {
  readonly config: CraConfig;
  readonly paths: CraPaths;
}

async function assertOwnerOnlyRegularFile(path: string, description: string): Promise<void> {
  const linkInfo = await lstat(path);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink())
    throw new Error(`${description} must be a regular non-symlink file`);
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error(`${description} must not grant group or other permissions`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${description} must be owned by the CRA user`);
  }
}

export async function loadConfig(configFile?: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  const initialPath = configFile ?? resolveCraPaths("cat-cave/tanren", env).configFile;
  if (!isAbsolute(initialPath)) throw new Error("config path must be absolute");
  const raw: unknown = JSON.parse(await readFile(initialPath, "utf8"));
  const config = craConfigSchema.parse(raw);
  const repositoryRoot = resolve(dirname(initialPath), config.repositoryRoot);
  const privateKeyPath = resolve(dirname(initialPath), config.github.privateKeyPath);
  const worktreeRoot = resolve(dirname(initialPath), config.isolation.worktreeRoot);
  const resolved = craConfigSchema.parse({
    ...config,
    repositoryRoot,
    github: { ...config.github, privateKeyPath },
    isolation: { ...config.isolation, worktreeRoot },
  });
  if (resolved.rubricVersion !== CRA_RUBRIC.version) {
    throw new Error(
      `configured rubric ${resolved.rubricVersion} does not match implemented rubric ${CRA_RUBRIC.version}`,
    );
  }
  const paths = resolveCraPaths(resolved.repository, { ...env, TANREN_CRA_CONFIG: initialPath });
  assertOutsideRepository(paths.stateRoot, repositoryRoot, "CRA state");
  assertOutsideRepository(privateKeyPath, repositoryRoot, "GitHub App private key");
  assertOutsideRepository(worktreeRoot, repositoryRoot, "throwaway worktrees");
  await assertOwnerOnlyRegularFile(privateKeyPath, "GitHub App private key");
  return { config: resolved, paths };
}
