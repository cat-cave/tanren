import {
  auditAnswerSchema,
  buildAuditPrompt,
  buildCheckPrompt,
  checkAnswerSchema,
  type AuditAnswer,
  type CheckAnswer,
} from "../providers/answererSchemas.js";
import type { AnswererAdapter } from "../providers/types.js";

// Generic, adapter-injected check/audit execution helpers shared by the real
// run path (subtaskStages) and the phase-1 fixture. There is NO fake adapter
// constructed here — callers pass the answerer (the real path resolves it from
// role-routing config; tests pass an explicit fixture).
export async function executeStructuredCheckTask(
  answerer: AnswererAdapter<CheckAnswer>,
  input: {
    specTitle: string;
    specDescription: string;
    acceptanceCriteria: string[];
    writerDiff: string;
    timeoutMs: number;
    workspace?: string;
  },
): Promise<CheckAnswer> {
  return await answerer.runAnswerer({
    prompt: buildCheckPrompt(input),
    timeoutMs: input.timeoutMs,
    workspace: input.workspace,
    outputSchema: checkAnswerSchema,
  });
}

export async function executeStructuredAuditTask(
  answerer: AnswererAdapter<AuditAnswer>,
  input: {
    specTitle: string;
    acceptanceCriteria: string[];
    checkAnswer: CheckAnswer;
    writerDiff: string;
    timeoutMs: number;
    workspace?: string;
  },
): Promise<AuditAnswer> {
  return await answerer.runAnswerer({
    prompt: buildAuditPrompt(input),
    timeoutMs: input.timeoutMs,
    workspace: input.workspace,
    outputSchema: auditAnswerSchema,
  });
}
