// Boot-time env schema (the fail-closed env contract). The schema is fed an
// explicit source object so these assertions never mutate the real process.env.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAllocatorEnv } from "../src/envSchema.js";

const GOOD_ENV = {
  ALLOCATOR_PORT: "3200",
  TANREN_MAX_RUN_HOURS: "6",
  TANREN_ALLOCATOR_NETWORK: "tanren_default",
  TANREN_ALLOCATOR_HOST_SSH_PORT: "2222",
  TANREN_ALLOCATOR_SSH_HOSTNAME_TEMPLATE: "{container}",
  TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS: "60000",
  TANREN_RUNNER_CAP_ADD: "SYS_ADMIN",
  TANREN_RUNNER_SECURITY_OPT: "apparmor=unconfined,seccomp=unconfined",
} satisfies NodeJS.ProcessEnv;

describe("allocator envSchema (fail-closed at boot)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a fully-populated good env and coerces numbers", () => {
    const env = parseAllocatorEnv(GOOD_ENV);
    expect(env.ALLOCATOR_PORT).toBe(3200);
    expect(env.TANREN_MAX_RUN_HOURS).toBe(6);
    expect(env.TANREN_ALLOCATOR_HOST_SSH_PORT).toBe(2222);
    expect(env.TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS).toBe(60_000);
    expect(env.TANREN_ALLOCATOR_NETWORK).toBe("tanren_default");
  });

  it("accepts an empty env via defaults", () => {
    const env = parseAllocatorEnv({});
    expect(env.ALLOCATOR_PORT).toBe(3200);
    expect(env.TANREN_MAX_RUN_HOURS).toBe(6);
    expect(env.TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS).toBe(60_000);
    expect(env.TANREN_ALLOCATOR_HOST_SSH_PORT).toBeUndefined();
  });

  // REGRESSION: compose's `${VAR:-}` materializes an unset host var as "" inside
  // the container. An empty value is UNSET — default applies / optional stays
  // undefined — never a boot crash.
  it("treats an EMPTY string as UNSET for optional/default fields (compose ${VAR:-})", () => {
    const env = parseAllocatorEnv({
      ALLOCATOR_PORT: "",
      TANREN_ALLOCATOR_NETWORK: "",
      TANREN_ALLOCATOR_HOST_SSH_PORT: "",
      TANREN_ALLOCATOR_SSH_HOSTNAME_TEMPLATE: "",
      TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS: "",
      TANREN_RUNNER_CAP_ADD: "",
      TANREN_RUNNER_SECURITY_OPT: "",
    });
    expect(env.ALLOCATOR_PORT).toBe(3200);
    expect(env.TANREN_ALLOCATOR_NETWORK).toBe("tanren_default");
    expect(env.TANREN_ALLOCATOR_HOST_SSH_PORT).toBeUndefined();
    expect(env.TANREN_ALLOCATOR_SSH_HOSTNAME_TEMPLATE).toBe("{container}");
    expect(env.TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS).toBe(60_000);
    expect(env.TANREN_RUNNER_CAP_ADD).toBe("SYS_ADMIN");
  });

  it("FAILS LOUD on a non-numeric ALLOCATOR_PORT", () => {
    expect(() => parseAllocatorEnv({ ...GOOD_ENV, ALLOCATOR_PORT: "abc" })).toThrow(/Invalid allocator environment/u);
  });

  it("FAILS LOUD on an out-of-range ALLOCATOR_PORT", () => {
    expect(() => parseAllocatorEnv({ ...GOOD_ENV, ALLOCATOR_PORT: "0" })).toThrow(/Invalid allocator environment/u);
  });

  it("FAILS LOUD on an out-of-range TANREN_ALLOCATOR_HOST_SSH_PORT", () => {
    expect(() => parseAllocatorEnv({ ...GOOD_ENV, TANREN_ALLOCATOR_HOST_SSH_PORT: "99999" })).toThrow(
      /Invalid allocator environment/u,
    );
  });

  it("FAILS LOUD on a non-positive TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS", () => {
    expect(() => parseAllocatorEnv({ ...GOOD_ENV, TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS: "0" })).toThrow(
      /Invalid allocator environment/u,
    );
  });

  // REAPER-SAFETY: TANREN_MAX_RUN_HOURS is integrated via `requirePositiveHours`,
  // which falls back LOUD (never crashes — a <= now reaper threshold would reap
  // every active runner). So a malformed value resolves to the default, with a
  // console.error, rather than throwing.
  it("falls back loud (NOT crash) on a non-positive TANREN_MAX_RUN_HOURS", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = parseAllocatorEnv({ ...GOOD_ENV, TANREN_MAX_RUN_HOURS: "0" });
    expect(env.TANREN_MAX_RUN_HOURS).toBe(6);
    expect(error).toHaveBeenCalledOnce();
  });

  it("falls back loud (NOT crash) on a non-numeric TANREN_MAX_RUN_HOURS", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = parseAllocatorEnv({ ...GOOD_ENV, TANREN_MAX_RUN_HOURS: "abc" });
    expect(env.TANREN_MAX_RUN_HOURS).toBe(6);
    expect(error).toHaveBeenCalledOnce();
  });
});
