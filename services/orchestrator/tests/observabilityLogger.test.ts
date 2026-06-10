// observability/logger: unit tests for the structured logger seam — proving each
// call emits ONE parseable JSON line carrying the level + message + correlation
// context, that the level filter (TANREN_LOG_LEVEL) drops sub-threshold lines, and
// that redaction strips tokens/URLs from both the message and the detail payload.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, redactLogString } from "../src/engine/observability/logger.js";

const lastLine = (spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> => {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls.at(-1)?.[0] as string) as Record<string, unknown>;
};

describe("structured logger", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env["TANREN_LOG_LEVEL"];
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    delete process.env["TANREN_LOG_LEVEL"];
  });

  it("emits one structured JSON line with level, message, component, and correlation ids", () => {
    const log = createLogger("merge-coordinator", { projectId: "project_1" });
    log.info("coordinate pass complete", { runId: "run_9" });
    expect(stdout).toHaveBeenCalledTimes(1);
    const line = lastLine(stdout);
    expect(line["level"]).toBe("info");
    expect(line["component"]).toBe("merge-coordinator");
    expect(line["msg"]).toBe("coordinate pass complete");
    expect(line["projectId"]).toBe("project_1");
    expect(line["runId"]).toBe("run_9");
    expect(typeof line["ts"]).toBe("string");
  });

  it("routes warn/error to stderr and info/debug to stdout", () => {
    const log = createLogger("dag-walker");
    log.error("walk failed", {}, new Error("boom"));
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(lastLine(stderr)["detail"]).toBe("boom");
  });

  it("filters lines below the configured level", () => {
    process.env["TANREN_LOG_LEVEL"] = "warn";
    const log = createLogger("intake-poller");
    log.info("polled");
    log.debug("detail");
    expect(stdout).not.toHaveBeenCalled();
    log.warn("backed off");
    // The only line that survived the filter is the warn — assert its content.
    const line = lastLine(stderr);
    expect(line["level"]).toBe("warn");
    expect(line["msg"]).toBe("backed off");
  });

  it("redacts tokens, api keys, and URLs from the message and the detail payload", () => {
    const log = createLogger("run-executor");
    log.error(
      "auth token=abc123 leaked",
      {},
      {
        url: "https://api.example.com/secret?token=zzz",
        note: "api_key=hunter2secret in here",
      },
    );
    const line = lastLine(stderr);
    expect(line["msg"]).toContain("[redacted]");
    expect(line["msg"]).not.toContain("abc123");
    const detail = line["detail"] as Record<string, string>;
    expect(detail["url"]).toBe("[url]");
    expect(detail["note"]).toContain("[redacted]");
    expect(detail["note"]).not.toContain("hunter2secret");
  });

  it("child() merges additional bound context", () => {
    const base = createLogger("worker", { orgId: "org_1" });
    const child = base.child({ runId: "run_2" });
    child.info("started");
    const line = lastLine(stdout);
    expect(line["orgId"]).toBe("org_1");
    expect(line["runId"]).toBe("run_2");
  });

  it("redactLogString strips secret-adjacent shapes", () => {
    expect(redactLogString("token=hunter2")).toBe("token=[redacted]");
    expect(redactLogString("see https://x.test/a")).toBe("see [url]");
  });
});
