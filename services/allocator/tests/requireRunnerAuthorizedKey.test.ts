import { afterEach, describe, expect, it } from "vitest";
import { requireRunnerAuthorizedKey } from "../src/requireRunnerAuthorizedKey.js";

describe("requireRunnerAuthorizedKey", () => {
  const original = process.env["TANREN_RUNNER_AUTHORIZED_KEY"];

  afterEach(() => {
    if (original === undefined) {
      delete process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
    } else {
      process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = original;
    }
  });

  it("throws LOUD when unset (no silent default)", () => {
    delete process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
    expect(() => requireRunnerAuthorizedKey()).toThrow(/TANREN_RUNNER_AUTHORIZED_KEY is required/u);
  });

  it("throws LOUD on a blank value (the v30 empty-sentinel class)", () => {
    process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = "";
    expect(() => requireRunnerAuthorizedKey()).toThrow(/TANREN_RUNNER_AUTHORIZED_KEY is required/u);
  });

  it("returns the configured authorized_keys line", () => {
    process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = "ssh-ed25519 AAAAReal orchestrator";
    expect(requireRunnerAuthorizedKey()).toBe("ssh-ed25519 AAAAReal orchestrator");
  });
});
