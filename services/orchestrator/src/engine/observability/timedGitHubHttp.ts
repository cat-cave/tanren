// observability: a timing decorator for the GitHub HTTP boundary. It
// implements GitHubHttpClient and delegates to a real client, emitting one
// structured timing record per request with the HTTP method, the path
// TEMPLATE (numeric ids/SHAs collapsed so cardinality stays bounded), the
// response status, and a `rateLimited` flag for 429s. The token and request
// body are never logged. Behavior (including the GitHub-App 401 re-mint retry) is
// unchanged — this only measures the round trip.
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../providers/github.js";
import { consoleTimingSink, timed, type TimingSink } from "./timing.js";

export class TimedGitHubHttpClient implements GitHubHttpClient {
  constructor(
    private readonly inner: GitHubHttpClient,
    private readonly sink: TimingSink = consoleTimingSink,
  ) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const pathTemplate = templatizePath(input.path);
    return timed(
      {
        boundary: "github",
        operation: "github.request",
        sink: this.sink,
        attributes: { method: input.method, path: pathTemplate },
      },
      async () => {
        const response = await this.inner.request(input);
        this.sink({
          event: "timing",
          boundary: "github",
          operation: "github.response",
          durationMs: 0,
          outcome: response.status >= 400 ? "error" : "ok",
          attributes: {
            method: input.method,
            path: pathTemplate,
            status: response.status,
            rateLimited: response.status === 429,
          },
          timestamp: new Date().toISOString(),
        });
        return response;
      },
    );
  }
}

// Collapses high-cardinality path segments (numeric ids, 40-char SHAs, query
// strings) to placeholders so timing records group by ENDPOINT, not by
// individual resource. Keeps the emitted `path` dimension low-cardinality for
// log aggregation without leaking specific repo/PR identifiers.
export function templatizePath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  return withoutQuery
    .split("/")
    .map((segment) => {
      if (segment === "") {
        return segment;
      }
      if (/^[0-9]+$/u.test(segment)) {
        return ":id";
      }
      if (/^[0-9a-f]{7,40}$/iu.test(segment)) {
        return ":sha";
      }
      return segment;
    })
    .join("/");
}
