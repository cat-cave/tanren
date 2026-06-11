import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import {
  canViewRaw,
  emitRedactionAudit,
  hasElevatedScope,
  isRedactionMarker,
  redactEventPayload,
} from "../src/engine/redaction/index.js";

// These tests pin the contract: redact by default, opt-in raw for
// elevated actors, emit an audit row when raw bytes flowed.

function actor(scopes: ActorContext["scopes"], overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: overrides.userId ?? "user_test",
    orgId: overrides.orgId ?? "org_test",
    projectId: overrides.projectId ?? "project_test",
    scopes,
    source: overrides.source ?? "session",
  };
}

describe("redaction scopes", () => {
  it("project_member only sees public", () => {
    const member = actor(["project:member"]);
    expect(canViewRaw("public", member)).toBe(true);
    expect(canViewRaw("redacted", member)).toBe(false);
    expect(canViewRaw("secret", member)).toBe(false);
    expect(hasElevatedScope(member)).toBe(false);
  });

  it("org:admin sees public + redacted but not secret", () => {
    const admin = actor(["org:admin"]);
    expect(canViewRaw("public", admin)).toBe(true);
    expect(canViewRaw("redacted", admin)).toBe(true);
    expect(canViewRaw("secret", admin)).toBe(false);
    expect(hasElevatedScope(admin)).toBe(true);
  });

  it("project:admin sees public + redacted but not secret", () => {
    const admin = actor(["project:admin"]);
    expect(canViewRaw("redacted", admin)).toBe(true);
    expect(canViewRaw("secret", admin)).toBe(false);
  });

  it("platform:admin sees every tier", () => {
    const admin = actor(["platform:admin"]);
    expect(canViewRaw("public", admin)).toBe(true);
    expect(canViewRaw("redacted", admin)).toBe(true);
    expect(canViewRaw("secret", admin)).toBe(true);
    expect(hasElevatedScope(admin)).toBe(true);
  });
});

describe("redaction serializer (by scope)", () => {
  it("project_member sees all redacted/secret fields hidden behind a marker", () => {
    const member = actor(["project:member"]);
    // hello.ssh_completed: target.host = redacted, stdout = secret.
    const payload = {
      runnerId: "runner_1",
      imageSha: "sha256:abc",
      target: {
        host: "10.0.0.1",
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "SHA256:xxx",
      },
      command: "echo hi",
      exitCode: 0,
      stdout: "tanren ok",
      stderr: "",
      timedOut: false,
    };
    const out = redactEventPayload({
      eventName: "hello.ssh_completed",
      payload,
      actor: member,
    });
    const view = out.payload as typeof payload;
    expect(view.runnerId).toBe("runner_1");
    expect(view.target.username).toBe("tanren");
    expect(isRedactionMarker(view.target.host)).toBe(true);
    expect(isRedactionMarker(view.target.port)).toBe(true);
    expect(isRedactionMarker(view.target.hostKeyFingerprint)).toBe(true);
    expect(isRedactionMarker(view.command)).toBe(true);
    expect(isRedactionMarker(view.stdout)).toBe(true);
    expect(isRedactionMarker(view.stderr)).toBe(true);
    expect(out.redactedPaths).toEqual(
      expect.arrayContaining([
        "target.host",
        "target.port",
        "target.hostKeyFingerprint",
        "command",
        "stdout",
        "stderr",
      ]),
    );
    expect(out.rawAccessedPaths).toEqual([]);
  });

  it("project:admin sees redacted as raw only with rawView=true; secret stays hidden", () => {
    const admin = actor(["project:admin"]);
    const payload = {
      runnerId: "runner_1",
      imageSha: "sha256:abc",
      target: {
        host: "10.0.0.1",
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "SHA256:xxx",
      },
      command: "echo hi",
      exitCode: 0,
      stdout: "tanren ok",
      stderr: "",
      timedOut: false,
    };
    // Without rawView, admin still sees redacted markers (safe default).
    const defaultView = redactEventPayload({
      eventName: "hello.ssh_completed",
      payload,
      actor: admin,
    });
    expect(isRedactionMarker((defaultView.payload as typeof payload).target.host)).toBe(true);
    expect(defaultView.rawAccessedPaths).toEqual([]);

    // With rawView, redacted-tier fields come through raw; secret remains
    // hidden since project:admin cannot view raw at secret tier.
    const rawAdmin = redactEventPayload({
      eventName: "hello.ssh_completed",
      payload,
      actor: admin,
      rawView: true,
    });
    const raw = rawAdmin.payload as typeof payload;
    expect(raw.target.host).toBe("10.0.0.1");
    expect(raw.command).toBe("echo hi");
    expect(isRedactionMarker(raw.stdout)).toBe(true);
    expect(rawAdmin.rawAccessedPaths).toEqual(
      expect.arrayContaining(["target.host", "target.port", "target.hostKeyFingerprint", "command"]),
    );
    expect(rawAdmin.redactedPaths).toEqual(expect.arrayContaining(["stdout", "stderr"]));
  });

  it("platform:admin with rawView=true sees every tier raw", () => {
    const admin = actor(["platform:admin"]);
    const payload = {
      runnerId: "runner_1",
      imageSha: "sha256:abc",
      target: {
        host: "10.0.0.1",
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "SHA256:xxx",
      },
      command: "echo hi",
      exitCode: 0,
      stdout: "tanren ok",
      stderr: "(error log here)",
      timedOut: false,
    };
    const out = redactEventPayload({
      eventName: "hello.ssh_completed",
      payload,
      actor: admin,
      rawView: true,
    });
    const view = out.payload as typeof payload;
    expect(view.stdout).toBe("tanren ok");
    expect(view.stderr).toBe("(error log here)");
    expect(view.target.host).toBe("10.0.0.1");
    expect(out.redactedPaths).toEqual([]);
    expect(out.rawAccessedPaths).toEqual(
      expect.arrayContaining([
        "stdout",
        "stderr",
        "target.host",
        "target.port",
        "target.hostKeyFingerprint",
        "command",
      ]),
    );
  });

  it("handles arrays via [] suffix path", () => {
    const member = actor(["project:member"]);
    const payload = {
      runId: "run_1",
      taskId: "task_1",
      subtaskIndex: 0,
      intent: "edit",
      decisions: [
        { summary: "added marker", code: "+ tanren ok", rationale: "AC1" },
        { summary: "added another", code: "+ tanren too", rationale: "AC2" },
      ],
      toolCalls: [{ name: "apply_diff", args: { path: "FILE.md" }, outputSummary: "ok" }],
      diffBytes: 12,
      commitSha: "abc",
    };
    const out = redactEventPayload({
      eventName: "writer.subtask.completed",
      payload,
      actor: member,
    });
    const view = out.payload as typeof payload;
    expect(view.decisions[0]?.summary).toBe("added marker");
    expect(isRedactionMarker(view.decisions[0]?.code)).toBe(true);
    expect(isRedactionMarker(view.decisions[1]?.code)).toBe(true);
    expect(isRedactionMarker(view.toolCalls[0]?.args)).toBe(true);
    expect(out.redactedPaths).toEqual(expect.arrayContaining(["decisions[].code", "toolCalls[].args"]));
  });

  it("clones the payload (does not mutate the input)", () => {
    const member = actor(["project:member"]);
    const original = {
      runnerId: "runner_1",
      imageSha: "sha256:abc",
      target: { host: "10.0.0.1", port: 22, username: "tanren", hostKeyFingerprint: "SHA256:xxx" },
      command: "echo hi",
      exitCode: 0,
      stdout: "tanren ok",
      stderr: "",
      timedOut: false,
    };
    redactEventPayload({ eventName: "hello.ssh_completed", payload: original, actor: member });
    expect(original.target.host).toBe("10.0.0.1");
    expect(original.command).toBe("echo hi");
  });
});

describe("redaction high-entropy heuristic", () => {
  it("bumps a public-tagged string that looks like a base64 credential to redacted", () => {
    const member = actor(["project:member"]);
    // run.queued.trigger is tagged public; we shove a long base64 blob in
    // there. The serializer should treat it as redacted.
    const longBase64 = "Y3JlZGVudGlhbHN1cGVybG9uZ29wYXF1ZXRva2VuMjAyNg==aaaaBBBBccccDDDD";
    const payload = {
      trigger: longBase64,
      branch: "main",
      plannerTaskId: "task",
      plannerJobId: "job",
      project: {
        repoUrl: "https://example.com/repo",
        defaultBranch: "main",
        runnerImage: "img",
        allocator: "local",
      },
      spec: {
        title: "do thing",
        acceptanceCriteria: ["AC1"],
        dependsOn: [],
      },
    };
    const out = redactEventPayload({
      eventName: "run.queued",
      payload,
      actor: member,
    });
    const view = out.payload as typeof payload;
    expect(isRedactionMarker(view.trigger)).toBe(true);
    expect(out.redactedPaths).toContain("trigger");
    // Normal short string fields untouched.
    expect(view.branch).toBe("main");
  });

  it("does NOT redact normal english prose", () => {
    const member = actor(["project:member"]);
    const prose =
      "The planner decided to decompose this work into three subtasks because the spec mentions multiple files and the dependencies are clear after re-reading the acceptance criteria.";
    const payload = {
      taskKind: "plan",
      intent: prose,
      rationale: prose,
    };
    const out = redactEventPayload({
      eventName: "planner.started",
      payload,
      actor: member,
    });
    const view = out.payload as typeof payload;
    expect(view.intent).toBe(prose);
    expect(view.rationale).toBe(prose);
    expect(out.redactedPaths).toEqual([]);
  });
});

describe("redaction audit emitter", () => {
  it("emits a redaction.raw_access event with the raw-access paths", async () => {
    const store = new FakeEventStore();
    const admin = actor(["platform:admin"], { userId: "user_admin" });
    await emitRedactionAudit({
      store,
      actor: admin,
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      taskId: "task_1",
      eventReadId: "42",
      eventReadType: "hello.ssh_completed",
      paths: ["stdout", "stderr", "target.host"],
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(store.events).toHaveLength(1);
    const audit = store.events[0]!;
    expect(audit.eventType).toBe("redaction.raw_access");
    expect(audit.payload).toEqual({
      actorUserId: "user_admin",
      actorScopes: ["platform:admin"],
      eventReadId: "42",
      eventReadType: "hello.ssh_completed",
      paths: ["stdout", "stderr", "target.host"],
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("does not emit when no raw paths were accessed", async () => {
    const store = new FakeEventStore();
    const admin = actor(["platform:admin"]);
    await emitRedactionAudit({
      store,
      actor: admin,
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      eventReadId: "1",
      eventReadType: "run.started",
      paths: [],
    });
    expect(store.events).toHaveLength(0);
  });
});

describe("redaction round-trip against Phase 1-shaped events", () => {
  // Synthesized fixture events shaped like the fixture timeline. Each is
  // serialized for a project_member; every redacted/secret field must come
  // back as a marker.
  const member = actor(["project:member"]);

  it("redacts the credentialRef on github.branch.pushed", () => {
    const out = redactEventPayload({
      eventName: "github.branch.pushed",
      payload: {
        repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
        branch: "feat/phase1",
        credentialRef: "secrets/github/token",
        redacted: true,
      },
      actor: member,
    });
    const view = out.payload as { credentialRef: unknown; repoUrl: string };
    expect(isRedactionMarker(view.credentialRef)).toBe(true);
    expect(view.repoUrl).toBe("https://github.com/cat-cave/tanren-fixture-easy");
    expect(out.redactedPaths).toContain("credentialRef");
  });

  it("redacts SSH stdout/stderr on hello.completed runnerProof", () => {
    const out = redactEventPayload({
      eventName: "hello.completed",
      payload: {
        outcome: "phase1_complete",
        workspacePath: "/workspace",
        runnerProof: {
          runnerId: "runner_1",
          imageSha: "sha256:abc",
          target: {
            host: "10.0.0.1",
            port: 22,
            username: "tanren",
            hostKeyFingerprint: "SHA256:xxx",
          },
          command: "tanren-hello",
          exitCode: 0,
          stdout: "tanren ok",
          stderr: "",
          timedOut: false,
        },
      },
      actor: member,
    });
    const view = out.payload as {
      outcome: string;
      runnerProof: { stdout: unknown; stderr: unknown; target: { host: unknown } };
    };
    expect(view.outcome).toBe("phase1_complete");
    expect(isRedactionMarker(view.runnerProof.stdout)).toBe(true);
    expect(isRedactionMarker(view.runnerProof.stderr)).toBe(true);
    expect(isRedactionMarker(view.runnerProof.target.host)).toBe(true);
  });

  it("public fields like outcome and pr url stay raw for project_member", () => {
    const out = redactEventPayload({
      eventName: "github.pr.created",
      payload: {
        repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
        branch: "feat/x",
        targetBranch: "main",
        prUrl: "https://github.com/cat-cave/tanren-fixture-easy/pull/12",
        prNumber: 12,
      },
      actor: member,
    });
    expect(out.redactedPaths).toEqual([]);
    const view = out.payload as { prUrl: string };
    expect(view.prUrl).toBe("https://github.com/cat-cave/tanren-fixture-easy/pull/12");
  });
});
