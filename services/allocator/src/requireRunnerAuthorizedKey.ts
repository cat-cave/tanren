/**
 * Resolve the PUBLIC authorized_keys line the runner's sshd trusts, from
 * `TANREN_RUNNER_AUTHORIZED_KEY`. A LOUD hard failure on unset/blank — NEVER a
 * silent `?? ""` (the v30 empty-sentinel class): an empty authorized key produces
 * a runner sshd that trusts NO key, so the orchestrator can never SSH in →
 * every command over that runner fails AFTER the alloc spent the container, an
 * infra-hold that masks the real cause (the missing config). Fail closed at
 * allocate time, with the same shape as `requireEnv` (named error, no default).
 *
 * In its own module (like `requireEnv.ts`) so a unit test can import + exercise it
 * WITHOUT pulling in the docker-client construction graph.
 */
export function requireRunnerAuthorizedKey(): string {
  const value = process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
  if (value === undefined || value === "") {
    throw new Error(
      "TANREN_RUNNER_AUTHORIZED_KEY is required (the runner's PUBLIC authorized_keys line; " +
        "an empty key produces a runner that can't be SSH'd — there is no default)",
    );
  }
  return value;
}
