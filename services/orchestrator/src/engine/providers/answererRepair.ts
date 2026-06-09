// ONE bounded schema-repair pass shared by the Codex + Claude Answerer adapters.
//
// A managed-answerer call whose model emits malformed JSON (or JSON that misses
// the output schema) is EXPENSIVE to recover from: in the spec loop an auditor
// schema miss becomes a synthetic P0 that drives a FULL loop iteration (re-plan +
// re-write + re-gate); a checker/conflict miss throws the whole stage. A single
// re-send of the SAME prompt + the zod error + "re-emit valid JSON" converts that
// expensive full-loop retry into ~1 cheap extra call.
//
// The pass is STRICTLY BOUNDED to one repair attempt (apex pre-run §7.1): on a
// first parse miss we re-run ONCE with the error appended; if THAT still fails we
// throw the SECOND error LOUD (an AnswererSchemaValidationError, same as before).
// There is no repair loop — exactly one extra call, then fail closed. Behavior is
// unchanged for a well-formed first answer (the repair branch is never entered).

import { AnswererSchemaValidationError } from "./answererSchemaError.js";

export interface SchemaRepairInput<TOutput> {
  // The schema whose `parse` validates the raw answer text → TOutput.
  schema: { name: string; parse(value: unknown): TOutput };
  // Parse + validate the raw model output text. Throws AnswererSchemaValidationError
  // on malformed JSON or a non-conforming object (the adapter's existing parse fn).
  parse(rawText: string): TOutput;
  // The raw answer text from the FIRST (already-run) model call.
  firstRawText: string;
  // The ORIGINAL prompt the first call used — the repair re-sends it verbatim with
  // the zod error appended so the model sees exactly what it failed.
  originalPrompt: string;
  // Re-run the model with the repair prompt and return its raw answer text. The
  // adapter closes this over its own SSH exec + response-file read.
  rerun(repairPrompt: string): Promise<string>;
}

/**
 * Parse `firstRawText`; on a schema/JSON miss, re-run the model ONCE with the same
 * prompt + the validation error + an instruction to re-emit valid JSON, then parse
 * that. A second miss throws the second error LOUD. Bounded to one repair call.
 */
export async function parseWithOneSchemaRepair<TOutput>(input: SchemaRepairInput<TOutput>): Promise<TOutput> {
  try {
    return input.parse(input.firstRawText);
  } catch (firstError) {
    if (!(firstError instanceof AnswererSchemaValidationError)) {
      throw firstError;
    }
    const repairPrompt = buildSchemaRepairPrompt(input.originalPrompt, input.schema.name, firstError.message);
    const repairedRawText = await input.rerun(repairPrompt);
    // The repaired call's output runs through the SAME parse — a second miss is a
    // genuine, non-transient failure and propagates LOUD (no further repair).
    return input.parse(repairedRawText);
  }
}

// The repair prompt: the original prompt verbatim, then the validation error and a
// terse, unambiguous re-emit instruction. Kept minimal so the only delta the model
// sees vs. its first attempt is the concrete reason it failed.
export function buildSchemaRepairPrompt(originalPrompt: string, schemaName: string, validationError: string): string {
  return [
    originalPrompt,
    "",
    "=== YOUR PREVIOUS ANSWER FAILED SCHEMA VALIDATION ===",
    `Your last response did not validate against the "${schemaName}" schema. The error was:`,
    validationError,
    "Re-emit ONLY a single, valid JSON object that conforms to the schema. Do not add",
    "prose, markdown fences, or comments — return the corrected JSON object alone.",
  ].join("\n");
}
