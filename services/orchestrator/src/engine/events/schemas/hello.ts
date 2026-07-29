import { z } from "zod";

const RunnerProofPayload = z
  .object({
    runnerId: z.string(),
    imageSha: z.string(),
    target: z
      .object({
        host: z.string(),
        port: z.number().int(),
        username: z.string(),
        hostKeyFingerprint: z.string(),
      })
      .strict(),
    command: z.string(),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
  })
  .strict();

export const HelloStartedPayload = z.object({}).strict();

export const HelloSshStartedPayload = z
  .object({
    runnerId: z.string(),
    command: z.string(),
    target: z
      .object({
        host: z.string(),
        port: z.number().int(),
        username: z.string(),
        hostKeyFingerprint: z.string(),
      })
      .strict(),
  })
  .strict();

export const HelloSshCompletedPayload = RunnerProofPayload;

export const HelloCompletedPayload = z
  .object({
    outcome: z.string(),
    runnerProof: RunnerProofPayload,
    workspacePath: z.string(),
  })
  .strict();

export const helloEventRegistry = {
  "hello.started": HelloStartedPayload,
  "hello.ssh_started": HelloSshStartedPayload,
  "hello.ssh_completed": HelloSshCompletedPayload,
  "hello.completed": HelloCompletedPayload,
} as const;
