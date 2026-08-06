import { describe, expect, it } from "vitest";
import { GitHubStatusService } from "../src/engine/providers/github.js";
import { githubTestPaths, requestedPaths, ScriptedGitHubHttp } from "./helpers/scriptedGitHubHttp.js";

const input = { repo: { owner: "o", name: "r" }, token: "t", baseBranch: "main" };
const paths = githubTestPaths;

describe("GitHub branch-rule proof pagination", () => {
  it("rejects a required status check on a later full page rather than proving an empty requirement", async () => {
    const firstPage = Array.from({ length: 100 }, () => ({ type: "pull_request" }));
    const http = new ScriptedGitHubHttp({
      [paths.requiredStatusChecks]: { status: 404, body: {} },
      [paths.branch]: { status: 200, body: { name: "main", protected: true } },
      [paths.protection]: { status: 200, body: { required_status_checks: null } },
      [paths.rules(1)]: { status: 200, body: firstPage },
      [paths.rules(2)]: { status: 200, body: [{ type: "required_status_checks" }] },
    });

    await expect(new GitHubStatusService(http).fetchRequiredContexts(input)).rejects.toThrow(/require status checks/u);
    expect(requestedPaths(http)).toEqual([
      paths.requiredStatusChecks,
      paths.branch,
      paths.protection,
      paths.rules(1),
      paths.rules(2),
    ]);
  });

  it("fails closed when a full rules page repeats instead of making pagination progress", async () => {
    const page = Array.from({ length: 100 }, () => ({ type: "pull_request" }));
    const http = new ScriptedGitHubHttp({
      [paths.requiredStatusChecks]: { status: 404, body: {} },
      [paths.branch]: { status: 200, body: { name: "main", protected: true } },
      [paths.protection]: { status: 404, body: {} },
      [paths.rules(1)]: { status: 200, body: page },
      [paths.rules(2)]: { status: 200, body: page },
    });

    await expect(new GitHubStatusService(http).fetchRequiredContexts(input)).rejects.toThrow(
      /pagination made no progress/u,
    );
    expect(requestedPaths(http)).toEqual([
      paths.requiredStatusChecks,
      paths.branch,
      paths.protection,
      paths.rules(1),
      paths.rules(2),
    ]);
  });

  it.each(["workflows", "code_scanning", "required_deployments", "future_check_gate"])(
    "rejects unrepresentable %s rules instead of emitting empty required contexts",
    async (type) => {
      const http = new ScriptedGitHubHttp({
        [paths.requiredStatusChecks]: { status: 404, body: {} },
        [paths.branch]: { status: 200, body: { name: "main", protected: true } },
        [paths.protection]: { status: 404, body: {} },
        [paths.rules(1)]: { status: 200, body: [{ type }] },
      });

      await expect(new GitHubStatusService(http).fetchRequiredContexts(input)).rejects.toThrow(
        new RegExp(`unrepresentable or check-producing rule type ${type}`, "u"),
      );
      expect(requestedPaths(http)).toEqual([
        paths.requiredStatusChecks,
        paths.branch,
        paths.protection,
        paths.rules(1),
      ]);
    },
  );

  it("negative control: an unknown path cannot consume a scripted response by position", async () => {
    const http = new ScriptedGitHubHttp({
      [paths.protection]: { status: 200, body: { required_status_checks: null } },
    });

    await expect(http.request({ method: "GET", path: paths.rules(1), token: "t" })).rejects.toThrow(
      /unexpected GitHub request path/u,
    );
  });

  it("negative control: swapped protection and rules payloads fail before a pass effect", async () => {
    const http = new ScriptedGitHubHttp({
      [paths.requiredStatusChecks]: { status: 404, body: {} },
      [paths.branch]: { status: 200, body: { name: "main", protected: true } },
      [paths.protection]: { status: 200, body: [{ type: "pull_request" }] },
      [paths.rules(1)]: { status: 200, body: { required_status_checks: null } },
    });
    let passEffects = 0;

    await expect(
      new GitHubStatusService(http).fetchRequiredContexts(input).then(() => {
        passEffects += 1;
      }),
    ).rejects.toThrow(/branch rules response was not an array/u);
    expect(passEffects).toBe(0);
    expect(requestedPaths(http)).toEqual([paths.requiredStatusChecks, paths.branch, paths.protection, paths.rules(1)]);
  });
});
