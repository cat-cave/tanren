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
      suggested_fixes: null,
    };
    const checkAdapter = new RecordingAnswerer(checkAnswer);
    const auditAdapter = new RecordingAnswerer({
      verified: true,
      criteria_status: {
        criteria: [{ criterion: "Adds ok", satisfied: true, reason: "The check and diff agree." }],
      },
      reason: "The check and diff agree.",
    });

    const baselineSha = "b".repeat(40);
    const check = await executeStructuredCheckTask(checkAdapter, {
      specTitle: "Fixture",
      specDescription: "Add ok",
      acceptanceCriteria: ["Adds ok"],
      baselineSha,
      timeoutMs: 100,
    });
    const audit = await executeStructuredAuditTask(auditAdapter, {
      specTitle: "Fixture",
      acceptanceCriteria: ["Adds ok"],
      checkAnswer: check,
      baselineSha,
      timeoutMs: 100,
    });

    expect(check.done).toBe(true);
    expect(audit.verified).toBe(true);
    expect(checkAdapter.lastSchemaName).toBe("tanren.check_answer.v1");
    expect(auditAdapter.lastSchemaName).toBe("tanren.audit_answer.v1");
    // The structured-task path routes through the SAME single-sourced prompt body
    // (answererPrompts.ts) as the production run path: the canonical role framing +
    // self-inspection block, the baseline sha, and no injected diff. Only the
    // closing instruction names this path's v1 schema fields.
    for (const prompt of [checkAdapter.lastPrompt ?? "", auditAdapter.lastPrompt ?? ""]) {
      expect(prompt).toContain(baselineSha);
      expect(prompt).toContain(`git diff ${baselineSha} -- . ':(exclude)node_modules'`);
      expect(prompt).toContain("Do NOT expect the diff");
      expect(prompt).not.toContain("diff --git");
    }
    // The checker's v1 closing (done / suggested_fixes), not the production v2
    // (passed / reasoning), confirms the schema-specific tail is wired correctly.
    expect(checkAdapter.lastPrompt).toContain(
      "Set done=true only when every acceptance criterion is satisfied. Use suggested_fixes=null when no fixes are needed.",
    );
    // The auditor's v1 closing (criteria_status) + the embedded checker answer.
    expect(auditAdapter.lastPrompt).toContain("Set criteria_status.criteria to one item per acceptance criterion.");
    expect(auditAdapter.lastPrompt).toContain('"done": true');
  });

  it("lets parse failures surface as hard task failures", async () => {
    const badAdapter: AnswererAdapter<CheckAnswer> = {
      kind: "answerer",
      cli: "codex",
      authRef: "credential/codex/answerer-tasks-test",
      async runAnswerer(opts) {
        return parseStructuredAnswererOutput("not-json", opts.outputSchema);
      },
    };

    await expect(
      executeStructuredCheckTask(badAdapter, {
        specTitle: "Fixture",
        specDescription: "Add ok",
        acceptanceCriteria: ["Adds ok"],
        baselineSha: "c".repeat(40),
        timeoutMs: 100,
      }),
    ).rejects.toThrow(AnswererSchemaValidationError);
  });
});

class RecordingAnswerer<TOutput> implements AnswererAdapter<TOutput> {
  readonly kind = "answerer";
  readonly cli = "fake";
  readonly authRef = "credential/self-hosted/answerer-tasks-test";
  lastSchemaName: string | undefined;
  lastPrompt: string | undefined;

  constructor(private readonly output: TOutput) {}

  async runAnswerer(opts: Parameters<AnswererAdapter<TOutput>["runAnswerer"]>[0]): Promise<TOutput> {
    this.lastSchemaName = opts.outputSchema?.name;
    this.lastPrompt = opts.prompt;
    return this.output;
  }
}
