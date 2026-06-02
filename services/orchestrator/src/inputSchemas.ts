// Request-body schemas for the root orchestrator endpoints in `main.ts`.
// Extracted to a sibling module to keep `main.ts` under the 500-line cap
// (architecture rule file-line-max-500); the shapes are unchanged.

import { z } from "zod";
import { SpecPriority } from "./engine/state/spec.js";

export const projectInputSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  runnerImage: z.string().min(1).optional(),
  allocator: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const specInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  // Execution priority (autonomy-engine.md §1b); omitted ⇒ the `tbd` default.
  priority: SpecPriority.optional(),
});

export const runInputSchema = z.object({
  trigger: z.enum(["cli", "dashboard", "api", "webhook"]).optional(),
  branch: z.string().min(1).optional(),
});

export const draftPrInputSchema = z.object({
  githubCredentialRef: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const ciPollInputSchema = z.object({
  githubCredentialRef: z.string().min(1).optional(),
});
