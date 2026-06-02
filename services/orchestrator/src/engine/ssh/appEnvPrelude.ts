// Plane B injection helper: turn a resolved app-env map into a shell prelude that
// EXPORTS each KEY into the environment the building agent's command runs under,
// then prepends it to that command. The values are the PROJECT's app secrets
// (resolved from `project_app_env` via `resolveAppEnvForScope`) — DISTINCT from
// Tanren's own provider creds, which never pass through here.
//
// SECURITY: the prelude is prepended ONLY to the EXECUTED command string handed to
// the SSH substrate — never to an event payload, a log line, or a process arg
// list. Callers keep emitting the ORIGINAL command in events (gate.* records
// `step.run`), so a secret value never lands in the events table. Each value is
// single-quote-escaped so it cannot break out of the assignment or inject shell.

import { quoteSshShellArg } from "./command.js";

/**
 * Build the `export K='v'; export K2='v2'; ` prelude for the app env. Keys are
 * emitted in a stable (sorted) order so the prepended command is deterministic.
 * An empty map yields the empty string (no prelude). Keys are validated as
 * POSIX-ish env var names so a malformed key cannot smuggle shell into the
 * `export` statement; the VALUE is single-quote-escaped (it is opaque secret
 * material and may contain anything but a null byte).
 */
export function buildAppEnvPrelude(appEnv: Record<string, string>): string {
  const keys = Object.keys(appEnv).sort();
  if (keys.length === 0) {
    return "";
  }
  const exports = keys.map((key) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`invalid app-env key for shell export: ${JSON.stringify(key)}`);
    }
    // quoteSshShellArg rejects null bytes and single-quote-escapes the value.
    return `export ${key}=${quoteSshShellArg(appEnv[key] ?? "")}`;
  });
  return `${exports.join("; ")}; `;
}

/**
 * Prepend the app-env prelude to a command so the building agent runs it WITH the
 * project's app env in scope. When the env is empty the command is returned
 * unchanged. The result is the EXECUTED string only — never logged/emitted.
 */
export function withAppEnv(command: string, appEnv: Record<string, string> | undefined): string {
  if (appEnv === undefined) {
    return command;
  }
  const prelude = buildAppEnvPrelude(appEnv);
  return prelude === "" ? command : `${prelude}${command}`;
}
