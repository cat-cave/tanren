import { z } from "zod";

export const ActorKind = z.enum([
  "system",
  "operator",
  "writer_codex",
  "answerer_codex",
  "forge_template",
  "ci_poller",
  // Phase 0/1 historical agent_kind values still persisted on tasks
  "writer",
  "answerer"
]);
export type ActorKind = z.infer<typeof ActorKind>;

// An ActorRef identifies the caller for audit/event purposes. Phase 2 callers
// should always pass one; the orchestrator falls back to `system` only at
// boundaries we control.
export const ActorRef = z.object({
  kind: ActorKind,
  id: z.string().min(1).optional(),
  label: z.string().min(1).optional()
});
export type ActorRef = z.infer<typeof ActorRef>;

export const systemActor: ActorRef = { kind: "system" };
