import { describe, expect, it } from "vitest";
import { EventRegistry, sensitivityFor } from "../src/engine/events/index.js";

describe("event domain extraction", () => {
  it("keeps the sensitive hello output classification after extraction", () => {
    expect(
      EventRegistry["hello.ssh_completed"].parse({
        runnerId: "runner-1",
        imageSha: "sha256:image",
        target: { host: "runner.internal", port: 22, username: "runner", hostKeyFingerprint: "fingerprint" },
        command: "echo hello",
        exitCode: 0,
        stdout: "sensitive output",
        stderr: "",
        timedOut: false,
      }).stdout,
    ).toBe("sensitive output");
    expect(sensitivityFor("hello.ssh_completed", "stdout")).toBe("secret");
  });
});
