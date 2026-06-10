// H10 hardening: the allocator `/healthz` docker liveness self-check decides
// reachability from the HTTP STATUS CODE the daemon answered with — NOT a body-
// string regex. `isHttpStatusError` is that decision: any error carrying a numeric
// `statusCode` (even a 404 for the synthetic self-check container) proves the
// daemon answered → reachable; a transport-level failure (daemon down) rejects
// without a `statusCode` → unreachable.
import { describe, expect, it } from "vitest";
import { isHttpStatusError } from "../src/dockerEngine.js";

function httpError(message: string, statusCode: number): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

describe("isHttpStatusError — statusCode-based docker liveness", () => {
  it("treats a 404 (daemon answered) as reachable", () => {
    expect(
      isHttpStatusError(httpError("Docker API GET /containers/x failed with status 404: no such container", 404)),
    ).toBe(true);
  });

  it("treats other HTTP statuses (400/500) as reachable", () => {
    expect(isHttpStatusError(httpError("bad request", 400))).toBe(true);
    expect(isHttpStatusError(httpError("server error", 500))).toBe(true);
  });

  it("treats a transport-level error WITHOUT a statusCode as unreachable", () => {
    // A socket failure (daemon gone) rejects with a plain error — no statusCode.
    expect(isHttpStatusError(new Error("connect ENOENT /var/run/docker.sock"))).toBe(false);
  });

  it("does not match a body string that merely mentions a status number", () => {
    // The prior body-regex would have matched "status 404" in any message; the
    // statusCode check ignores message text entirely.
    expect(isHttpStatusError(new Error("the runner returned status 404 in its logs"))).toBe(false);
  });

  it("rejects non-error values", () => {
    const nothing: unknown = (() => {})();
    expect(isHttpStatusError(nothing)).toBe(false);
    expect(isHttpStatusError("status 500")).toBe(false);
    expect(isHttpStatusError({ statusCode: 404 })).toBe(false);
  });
});
