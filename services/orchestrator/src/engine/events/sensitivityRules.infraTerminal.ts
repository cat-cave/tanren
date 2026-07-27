import type { SensitivityRule } from "./sensitivity.js";
import { integrationProvisioningSensitivityRules } from "./sensitivityRules.integrations.js";

export const infraTerminalSensitivityRules: SensitivityRule[] = [
  ...rulesFor("notification.enqueued", [
    ["channel", "public"],
    ["eventName", "public"],
  ]),
  ...rulesFor("notification.sent", [
    ["channel", "public"],
    ["attempts", "public"],
  ]),
  ...rulesFor("notification.failed", [
    ["channel", "public"],
    ["message", "public"],
  ]),
  ...integrationProvisioningSensitivityRules,
  ...rulesFor("hello.started", []),
  ...rulesFor("hello.ssh_started", [
    ["runnerId", "public"],
    ["command", "redacted"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"],
  ]),
  ...rulesFor("hello.ssh_completed", [
    ["runnerId", "public"],
    ["imageSha", "public"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"],
    ["command", "redacted"],
    ["exitCode", "public"],
    ["stdout", "secret"],
    ["stderr", "secret"],
    ["timedOut", "public"],
  ]),
  ...rulesFor("hello.completed", [
    ["outcome", "public"],
    ["workspacePath", "public"],
    ["runnerProof.runnerId", "public"],
    ["runnerProof.imageSha", "public"],
    ["runnerProof.target.host", "redacted"],
    ["runnerProof.target.port", "redacted"],
    ["runnerProof.target.username", "public"],
    ["runnerProof.target.hostKeyFingerprint", "redacted"],
    ["runnerProof.command", "redacted"],
    ["runnerProof.exitCode", "public"],
    ["runnerProof.stdout", "secret"],
    ["runnerProof.stderr", "secret"],
    ["runnerProof.timedOut", "public"],
  ]),
  ...rulesFor("redaction.raw_access", [
    ["actorUserId", "public"],
    ["actorScopes", "public"],
    ["actorScopes[]", "public"],
    ["eventReadId", "public"],
    ["eventReadType", "public"],
    ["paths", "public"],
    ["paths[]", "public"],
    ["at", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
