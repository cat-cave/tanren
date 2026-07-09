import { describe, expect, it } from "vitest";
import {
  FakeAllocator,
  FakeCostResolver,
  FakeInternalOrchestratorRpc,
  FakeJobQueue,
  FakeNotificationOutbox,
  FakeSecretStore,
  FakeCommandSubstrate,
  conflictToFinding,
  type IdentityProvider,
  type IssueSource,
  type RecordedConflict,
} from "../src/engine/contracts/index.js";

describe("orchestrator scaffold contracts", () => {
  it("provides fake implementations for hello-world contract paths", async () => {
    const allocator = new FakeAllocator();
    const allocation = await allocator.allocate({
      runId: "run_1",
      projectId: "project_1",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      identitySecretRef: "runner/run_1/identity",
    });
    const ssh = await new FakeCommandSubstrate().run(allocation.target, {
      command: "echo ok",
      timeoutMs: 100,
    });
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/fake", value: "secret" });
    const cost = await new FakeCostResolver().resolve({
      provider: "fake",
      model: "fake",
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 2,
    });
    const queue = new FakeJobQueue();
    const job = await queue.enqueue({ taskKind: "plan", payload: { ok: true } });
    const notification = await new FakeNotificationOutbox().enqueue({
      channel: "ntfy",
      payload: { runId: "run_1" },
    });
    const rpcRun = await new FakeInternalOrchestratorRpc().createRun({
      specId: "spec_1",
      projectId: "project_1",
    });

    expect(allocation.runnerId).toBe("runner_run_1");
    // Pin the full FakeAllocation shape: every literal the fake derives from the
    // request is a distinct mutation survivor unless asserted here. imageSha is
    // the request image suffixed with the fake digest; the RunnerHandle carries the
    // fixed dev host/port/user, a SHA256 fingerprint, and echoes the request's
    // identity ref (never inlined key material).
    expect(allocation.imageSha).toBe("ghcr.io/cat-cave/tanren-runner:v0@sha256:fake");
    expect(allocation.target).toEqual({
      backend: "ssh",
      host: "runner",
      port: 22,
      username: "tanren",
      hostKeyFingerprint: "SHA256:fake",
      identitySecretRef: "runner/run_1/identity",
    });
    await expect(allocator.release(allocation.runnerId)).resolves.toBeUndefined();
    expect(ssh.exitCode).toBe(0);
    await expect(secrets.get("credential/fake")).resolves.toEqual({
      ref: "credential/fake",
      value: "secret",
    });
    expect(cost.costBasis).toBe("unknown");
    expect(cost.costUsd).toBeNull();
    expect(job.id).toBe("job_1");
    expect(notification.id).toBe("notification_1");
    expect(rpcRun.status).toBe("queued");
  });

  // workspaceVcsCore.conflictToFinding — pure RecordedConflict → Finding adapter
  // (MergeAuthority gates on conflicts-as-findings). Also pinned in the
  // WorkspaceVcsCore conformance suite when a rebase records a conflict.
  it("conflictToFinding maps a recorded conflict to a P0 finding", () => {
    const conflict: RecordedConflict = {
      conflictId: "c-1",
      between: { specId: "spec_a", otherSpecId: "spec_b" },
      paths: ["src/a.ts", "src/b.ts"],
    };
    const finding = conflictToFinding(conflict);
    expect(finding).toEqual({
      id: "conflict:c-1",
      severity: "P0",
      title: "Unresolved conflict between spec_a and spec_b",
      body: "Conflicted paths: src/a.ts, src/b.ts",
      fixHint: "Resolve the recorded conflict (intent-preserving) before export/land.",
    });
  });

  // engineSeams.ts — pluggable IssueSource + IdentityProvider (tanren-owns-the-engine
  // §6). Distinct from the auth-package IdentityProvider and the inbox SourceConnector;
  // these are the purpose-based contract shapes Wave-2 aligns connectors onto.
  it("engineSeams IssueSource + IdentityProvider are implementable shapes", async () => {
    const source: IssueSource = {
      async fetch(ref) {
        expect(ref.sourceKind).toBe("github");
        expect(ref.locator).toBe("owner/repo");
        return [{ externalId: "1", title: "t", body: "b", sourceKind: "github" }];
      },
    };
    const items = await source.fetch({ sourceKind: "github", locator: "owner/repo" });
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe("1");

    const idp: IdentityProvider = {
      buildAuthorizeUrl(input) {
        return `https://idp.example/authorize?state=${input.state}&redirect_uri=${encodeURIComponent(input.redirectUri)}`;
      },
      async exchangeCode(input) {
        expect(input.code).toBe("code_1");
        return { subject: "user_1", login: "alice", accessToken: "tok" };
      },
    };
    expect(idp.buildAuthorizeUrl({ state: "s", redirectUri: "https://cb", scopes: ["read"] })).toContain("state=s");
    await expect(idp.exchangeCode({ code: "code_1", state: "s", redirectUri: "https://cb" })).resolves.toEqual({
      subject: "user_1",
      login: "alice",
      accessToken: "tok",
    });
  });
});
