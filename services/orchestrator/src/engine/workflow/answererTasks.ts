import {
  auditAnswerSchema,
  checkAnswerSchema,
  type AuditAnswer,
  type CheckAnswer,
} from "../providers/answererSchemas.js";
import type { AnswererAdapter } from "../providers/types.js";
import { buildAuditorPrompt, buildCheckerPrompt } from "./answererPrompts.js";

// The structured-task path's v1 schema closing instructions. The shared prompt
// body lives in answererPrompts.ts (single-sourced with the production run path);
// only these tails name this path's v1 output fields.
const STRUCTURED_CHECK_OUTPUT_INSTRUCTIONS = [
  "Set done=true only when every acceptance criterion is satisfied. Use suggested_fixes=null when no fixes are needed.",
];
const STRUCTURED_AUDIT_OUTPUT_INSTRUCTIONS = ["Set criteria_status.criteria to one item per acceptance criterion."];

// Generic, adapter-injected check/audit execution helpers shared by the real
// run path (subtaskStages) and the phase-1 fixture. There is NO fake adapter
// constructed here — callers pass the answerer (the real path resolves it from
// role-routing config; tests pass an explicit fixture). The PROMPT TEXT is the
// same single source the production checker/auditor use (answererPrompts.ts);
// only the v1-schema closing instruction differs.
export async function executeStructuredCheckTask(
  answerer: AnswererAdapter<CheckAnswer>,
  input: {
    specTitle: string;
    specDescription: string;
    acceptanceCriteria: string[];
    baselineSha: string;
    timeoutMs: number;
    workspace?: string;
  },
): Promise<CheckAnswer> {
  return await answerer.runAnswerer({
    prompt: buildCheckerPrompt({
      specTitle: input.specTitle,
      specDescription: input.specDescription,
      acceptanceCriteria: input.acceptanceCriteria,
      baselineSha: input.baselineSha,
      outputInstructions: STRUCTURED_CHECK_OUTPUT_INSTRUCTIONS,
    }),
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
    baselineSha: string;
    timeoutMs: number;
    workspace?: string;
  },
): Promise<AuditAnswer> {
  return await answerer.runAnswerer({
    prompt: buildAuditorPrompt({
      specTitle: input.specTitle,
      acceptanceCriteria: input.acceptanceCriteria,
      baselineSha: input.baselineSha,
      checkAnswer: input.checkAnswer,
      outputInstructions: STRUCTURED_AUDIT_OUTPUT_INSTRUCTIONS,
    }),
    timeoutMs: input.timeoutMs,
    workspace: input.workspace,
    outputSchema: auditAnswerSchema,
  });
}
