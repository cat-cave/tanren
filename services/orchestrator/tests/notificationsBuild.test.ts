// Tests for buildNotificationDispatcher (the production construction site): the
// channel registry is built with the real `secrets` dep (so every kind is WIRED,
// not stubbed), a missing secret store is a LOUD throw (a stub-only registry
// would silently swallow escalations), and the code-level default route is
// resolved from the environment with an unknown channel kind a LOUD throw.

import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { buildNotificationDispatcher } from "../src/engine/notifications/build.js";
import type { SecretStore } from "../src/engine/contracts/index.js";

const fakeSecrets = {} as unknown as SecretStore;
const fakePool = {} as unknown as pg.Pool;

const DEFAULT_ENV_KEYS = [
  "TANREN_NOTIFICATION_DEFAULT_CHANNEL",
  "TANREN_NOTIFICATION_DEFAULT_DESTINATION",
  "TANREN_NOTIFICATION_DEFAULT_MIN_SEVERITY",
  "TANREN_APEX_MODE",
] as const;

function clearDefaultEnv(): void {
  for (const key of DEFAULT_ENV_KEYS) delete process.env[key];
}

describe("buildNotificationDispatcher", () => {
  afterEach(clearDefaultEnv);

  it("builds a dispatcher with no default route when the env is unset", () => {
    clearDefaultEnv();
    const dispatcher = buildNotificationDispatcher({ pool: fakePool, secrets: fakeSecrets });
    expect(dispatcher).toBeDefined();
  });

  it("LOUD-throws when the secret store dep is missing (channels could only stub)", () => {
    expect(() => buildNotificationDispatcher({ pool: fakePool, secrets: undefined as unknown as SecretStore })).toThrow(
      /requires a secret store/u,
    );
  });

  it("resolves a default route from the environment", () => {
    process.env["TANREN_NOTIFICATION_DEFAULT_CHANNEL"] = "ntfy";
    process.env["TANREN_NOTIFICATION_DEFAULT_DESTINATION"] = "tanren-escalations";
    // Should not throw — a valid default route is constructed.
    expect(() => buildNotificationDispatcher({ pool: fakePool, secrets: fakeSecrets })).not.toThrow();
  });

  it("LOUD-throws on an unknown default channel kind (a typo must not disable the safety net)", () => {
    process.env["TANREN_NOTIFICATION_DEFAULT_CHANNEL"] = "not-a-channel";
    process.env["TANREN_NOTIFICATION_DEFAULT_DESTINATION"] = "x";
    expect(() => buildNotificationDispatcher({ pool: fakePool, secrets: fakeSecrets })).toThrow(
      /not a known channel kind/u,
    );
  });

  it("apex mode LOUD-throws when no default route is configured (a warn+ milestone would silent-log)", () => {
    // Loop 5 readiness: in apex mode a deliverable-but-unrouted warn+ event must be
    // a startup FAILURE, not a silent log-and-return inside the dispatcher.
    process.env["TANREN_APEX_MODE"] = "1";
    expect(() => buildNotificationDispatcher({ pool: fakePool, secrets: fakeSecrets })).toThrow(
      /apex mode requires a code-level default notification route/u,
    );
  });

  it("apex mode builds normally once a default route is configured", () => {
    process.env["TANREN_APEX_MODE"] = "1";
    process.env["TANREN_NOTIFICATION_DEFAULT_CHANNEL"] = "ntfy";
    process.env["TANREN_NOTIFICATION_DEFAULT_DESTINATION"] = "tanren-default-alerts";
    expect(() => buildNotificationDispatcher({ pool: fakePool, secrets: fakeSecrets })).not.toThrow();
  });
});
