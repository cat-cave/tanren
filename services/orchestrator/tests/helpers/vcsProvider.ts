// Test helper: wrap a (scripted/fake) `GitHubHttpClient` in the REAL
// `GitHubVcsProvider`, so tests that previously injected a `githubHttp` into a
// run/merge stage now inject a `vcsProvider` that composes their same fake
// transport. This proves the provider's wrapping over the existing GitHub
// services with zero new mocking — behavior is identical to the prior
// `githubHttp` path. The provider's purely in-memory contract fake (for the
// conformance suite) lives under `tests/conformance/fakes/`.
import type { GitHubHttpClient } from "../../src/engine/providers/github.js";
import { GitHubVcsProvider } from "../../src/engine/providers/githubVcsProvider.js";
import type { VcsProvider } from "../../src/engine/contracts/vcsProvider.js";

/** A real GitHubVcsProvider over the given (test) HTTP transport. */
export function vcsProviderOver(http: GitHubHttpClient): VcsProvider {
  return new GitHubVcsProvider(http);
}
