import { describe, expect, it, vi } from "vitest";
import { FetchGitHubHttpClient } from "../src/engine/providers/github.js";

describe("GitHub HTTP path-prefixed pagination", () => {
  it("returns a base-relative next path for a path-prefixed GitHub API", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("[]", {
          status: 200,
          headers: {
            Link: '<https://ghe.example/api/v3/repos/acme/app/issues?page=2>; rel="next"',
          },
        }),
    );
    const client = new FetchGitHubHttpClient({
      apiBaseUrl: "https://ghe.example/api/v3",
      fetchImpl,
      sleep: async () => {},
    });

    const response = await client.request({ method: "GET", path: "/repos/acme/app/issues", token: "token" });

    expect(response.nextPagePath).toBe("/repos/acme/app/issues?page=2");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ghe.example/api/v3/repos/acme/app/issues",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects an absolute next link outside the configured API path", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { Link: '<https://ghe.example/repos/acme/app/issues?page=2>; rel="next"' },
        }),
    );
    const client = new FetchGitHubHttpClient({
      apiBaseUrl: "https://ghe.example/api/v3",
      fetchImpl,
      sleep: async () => {},
    });

    await expect(client.request({ method: "GET", path: "/repos/acme/app/issues", token: "token" })).rejects.toThrow(
      /outside the configured base path/u,
    );
  });
});
