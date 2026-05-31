import {
  auditAnswerSchema,
  buildAuditPrompt,
  buildCheckPrompt,
  checkAnswerSchema,
  type AuditAnswer,
  type CheckAnswer,
} from "../providers/answererSchemas.js";
import type { AnswererAdapter } from "../providers/types.js";

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
