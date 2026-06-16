import { describe, expect, it } from "vitest";
import {
  EventRegistry,
  listEventNames,
  listSensitivityPathsFor,
  listSensitivityRules,
  sensitivityFor,
} from "../src/engine/events/index.js";

// Enumerates every leaf path in a Zod schema. Used to assert sensitivity
// coverage: every reachable payload field must have a registered tag.
function collectZodPaths(schema: unknown, prefix = ""): string[] {
  const paths: string[] = [];
  const def = (
    schema as {
      def?: {
        type?: string;
        shape?: Record<string, unknown>;
        element?: unknown;
        innerType?: unknown;
        options?: unknown[];
      };
    }
  ).def;
  if (def === undefined) {
    if (prefix !== "") {
      paths.push(prefix);
    }
    return paths;
  }
  const type = def.type;
  if (type === "object" && def.shape !== undefined) {
    for (const [key, value] of Object.entries(def.shape)) {
      paths.push(...collectZodPaths(value, prefix === "" ? key : `${prefix}.${key}`));
    }
    return paths;
  }
  if (type === "array" && def.element !== undefined) {
    paths.push(...collectZodPaths(def.element, `${prefix}[]`));
    return paths;
  }
  if ((type === "optional" || type === "nullable" || type === "default") && def.innerType !== undefined) {
    paths.push(...collectZodPaths(def.innerType, prefix));
    return paths;
  }
  if (type === "union" && Array.isArray(def.options)) {
    // Use the first non-null option for path discovery; sensitivity rules
    // can register paths under the same parent regardless of union branch.
    const first = def.options.find((opt) => {
      const optDef = (opt as { def?: { type?: string } }).def;
      return optDef?.type !== "null";
    });
    if (first !== undefined) {
      paths.push(...collectZodPaths(first, prefix));
      return paths;
    }
  }
  if (prefix !== "") {
    paths.push(prefix);
  }
  return paths;
}

describe("event semantic fields", () => {
  it("every payload field for every event has a registered sensitivity tag", () => {
    const missing: Array<{ eventName: string; path: string }> = [];
    for (const name of listEventNames()) {
      const schema = EventRegistry[name];
      const paths = collectZodPaths(schema);
      for (const path of paths) {
        if (sensitivityFor(name, path) === undefined) {
          missing.push({ eventName: name, path });
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("planner.subtasks.emitted carries semantic-rich fields", () => {
    const schema = EventRegistry["planner.subtasks.emitted"];
    const sample = {
      runId: "run_1",
      taskId: "task_1",
      subtasks: [
        {
          index: 0,
          title: "first subtask",
          intent: "demonstrate planner emit",
          estimatedTokens: 500,
          behaviorIds: ["B1", "B2"],
        },
      ],
      rationale: "decompose by file boundary",
    };
    expect(() => schema.parse(sample)).not.toThrow();
  });

  it("writer.subtask.completed carries structured decisions and tool calls", () => {
    const schema = EventRegistry["writer.subtask.completed"];
    const sample = {
      runId: "run_1",
      taskId: "task_1",
      subtaskIndex: 0,
      intent: "edit file X to satisfy AC1",
      decisions: [
        {
          summary: "added marker line",
          code: "+ tanren ok",
          rationale: "AC1 requires marker file",
        },
      ],
      toolCalls: [{ name: "apply_diff", args: { path: "PHASE1.md" }, outputSummary: "diff applied" }],
      diffBytes: 42,
      commitSha: "deadbeef",
    };
    expect(() => schema.parse(sample)).not.toThrow();
  });

  it("checker.verdict carries completeness + findings; auditor.verdict is findings-only", () => {
    const verdict = EventRegistry["checker.verdict"].parse({
      runId: "run_1",
      taskId: "task_1",
      subtaskIndex: 0,
      complete: true,
      reasoning: "all downstream-relevant behaviors delivered",
      behaviorIdsFailed: [],
      findings: [],
      emptyIncrementalDiff: false,
    });
    expect(verdict.complete).toBe(true);

    const audit = EventRegistry["auditor.verdict"].parse({
      runId: "run_1",
      findings: [{ id: "f", severity: "P1", title: "t", body: "b" }],
    });
    expect(audit.findings[0]?.severity).toBe("P1");
  });

  it("registered sensitivity rules cover all the documented sensitive fields", () => {
    // sensitive tags: secret is reserved for raw stdout/stderr; ensure at
    // least one such registration exists so the redaction layer has
    // a downstream contract to test against.
    const rules = listSensitivityRules();
    const secrets = rules.filter((rule) => rule.tag === "secret");
    expect(secrets.length).toBeGreaterThan(0);
    // hello.ssh_completed.stdout must be tagged secret because it carries
    // raw SSH command output.
    expect(sensitivityFor("hello.ssh_completed", "stdout")).toBe("secret");
    // credential refs in github events must be redacted, not secret.
    expect(sensitivityFor("github.branch.pushed", "credentialRef")).toBe("redacted");
    // public reasoning fields stay public so member dashboards render them.
    expect(sensitivityFor("checker.verdict", "reasoning")).toBe("public");
  });

  it("listSensitivityPathsFor returns the paths registered for an event", () => {
    const paths = listSensitivityPathsFor("run.queued");
    expect(paths).toContain("trigger");
    expect(paths).toContain("project.repoUrl");
    expect(paths).toContain("spec.acceptanceCriteria[]");
  });
});
