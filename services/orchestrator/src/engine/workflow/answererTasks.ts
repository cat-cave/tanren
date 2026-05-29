import {
  auditAnswerSchema,
  buildAuditPrompt,
  buildCheckPrompt,
  checkAnswerSchema,
  planAnswerSchema,
  type AuditAnswer,
  type CheckAnswer,
} from "../providers/answererSchemas.js";
import { fakeAuditor, fakeChecker, fakePlanner } from "../providers/fake.js";
import type { AnswererAdapter } from "../providers/types.js";

export async function executePlanTask(): Promise<string> {
  const plan = await fakePlanner.runAnswerer({
    prompt: "Plan hello world",
    timeoutMs: 1_000,
    outputSchema: planAnswerSchema,
  });
  return plan.subtasks[0]?.title ?? "Fake writer";
}

export async function executeCheckTask(diff: string | undefined) {
  return await executeStructuredCheckTask(fakeChecker, {
    specTitle: "Hello world",
    specDescription: "Prove Tanren service connectivity",
    acceptanceCriteria: ["The orchestrator persists a completed synthetic run"],
    writerDiff: diff ?? "",
    timeoutMs: 1_000,
  });
}

export async function executeAuditTask(checkAnswer?: CheckAnswer, writerDiff = "") {
  return await executeStructuredAuditTask(fakeAuditor, {
    specTitle: "Hello world",
    acceptanceCriteria: ["The orchestrator persists a completed synthetic run"],
    checkAnswer: checkAnswer ?? {
      done: false,
      reason: "No checker answer was supplied.",
      suggested_fixes: ["Run checker first."],
    },
    writerDiff,
    timeoutMs: 1_000,
  });
}

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
