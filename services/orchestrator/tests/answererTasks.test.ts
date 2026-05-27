import { describe, expect, it } from "vitest";
import type { CheckAnswer } from "../src/engine/providers/answererSchemas.js";
import { AnswererSchemaValidationError, parseStructuredAnswererOutput } from "../src/engine/providers/codex.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { executeStructuredAuditTask, executeStructuredCheckTask } from "../src/engine/workflow/answererTasks.js";

describe("structured Answerer task helpers", () => {
  it("runs check and audit Answerers with schemas", async () => {
    const checkAnswer: CheckAnswer = {
      done: true,
      reason: "Diff satisfies the spec.",
      suggested_fixes: null
    };
    const checkAdapter = new RecordingAnswerer(checkAnswer);
    const auditAdapter = new RecordingAnswerer({
      verified: true,
      criteria_status: { criteria: [{ criterion: "Adds ok", satisfied: true, reason: "The check and diff agree." }] },
      reason: "The check and diff agree."
    });

    const check = await executeStructuredCheckTask(checkAdapter, {
      specTitle: "Fixture",
      specDescription: "Add ok",
      acceptanceCriteria: ["Adds ok"],
      writerDiff: "diff\n+ok\n",
      timeoutMs: 100
    });
    const audit = await executeStructuredAuditTask(auditAdapter, {
      specTitle: "Fixture",
      acceptanceCriteria: ["Adds ok"],
      checkAnswer: check,
      writerDiff: "diff\n+ok\n",
      timeoutMs: 100
    });

    expect(check.done).toBe(true);
    expect(audit.verified).toBe(true);
    expect(checkAdapter.lastSchemaName).toBe("tanren.check_answer.v1");
    expect(auditAdapter.lastSchemaName).toBe("tanren.audit_answer.v1");
  });

  it("lets parse failures surface as hard task failures", async () => {
    const badAdapter: AnswererAdapter<CheckAnswer> = {
      kind: "answerer",
      cli: "codex",
      authRef: "credential/codex/answerer-tasks-test",
      async runAnswerer(opts) {
        return parseStructuredAnswererOutput("not-json", opts.outputSchema);
      }
    };

    await expect(
      executeStructuredCheckTask(badAdapter, {
        specTitle: "Fixture",
        specDescription: "Add ok",
        acceptanceCriteria: ["Adds ok"],
        writerDiff: "diff\n+ok\n",
        timeoutMs: 100
      })
    ).rejects.toThrow(AnswererSchemaValidationError);
  });
});

class RecordingAnswerer<TOutput> implements AnswererAdapter<TOutput> {
  readonly kind = "answerer";
  readonly cli = "fake";
  readonly authRef = "credential/self-hosted/answerer-tasks-test";
  lastSchemaName: string | undefined;

  constructor(private readonly output: TOutput) {}

  async runAnswerer(opts: Parameters<AnswererAdapter<TOutput>["runAnswerer"]>[0]): Promise<TOutput> {
    this.lastSchemaName = opts.outputSchema?.name;
    return this.output;
  }
}
