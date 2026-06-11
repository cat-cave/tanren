// Test helper: a few stock `GitHubHttpClient` stand-ins for the run/merge stages that
// thread the shared GitHub HTTP client (decomposition PR-9 retired the `VcsProvider`
// seam — a stage now holds the `GitHubHttpClient` directly). A test that exercises a
// WIRING / SCOPING path (not an actual GitHub round trip) injects `inertGitHubHttp()`,
// which throws LOUDLY if any code path unexpectedly reaches the transport.
import type { GitHubHttpClient } from "../../src/engine/providers/github.js";

/** A `GitHubHttpClient` whose every request throws — proves the path under test never hits GitHub. */
export function inertGitHubHttp(): GitHubHttpClient {
  return {
    async request() {
      throw new Error("inertGitHubHttp: the GitHub transport must not be reached on this path");
    },
  };
}
