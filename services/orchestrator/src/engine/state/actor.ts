import { z } from "zod";

// The canonical actor / `agent_kind` vocabulary (v21). The implementation-coupled
// `writer`/`answerer` are the values actually written to `tasks.agent_kind`
// (the planner/writer/answerer tasks) — the aspirational `writer_codex`/
// `answerer_codex` duplicates were never written and were pruned, leaving ONE
// vocabulary.
export const ActorKind = z.enum(["system", "operator", "writer", "answerer", "forge_template", "ci_poller"]);
export type ActorKind = z.infer<typeof ActorKind>;

// An ActorRef identifies the caller for audit/event purposes. Callers
// should always pass one; the orchestrator falls back to `system` only at
// boundaries we control.
export const ActorRef = z.object({
  kind: ActorKind,
  id: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
});
export type ActorRef = z.infer<typeof ActorRef>;

export const systemActor: ActorRef = { kind: "system" };
