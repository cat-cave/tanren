import { expect, it } from "vitest";
import { FetchGitHubHttpClient } from "../src/engine/providers/github.js";
const request = (link: string) =>
  new FetchGitHubHttpClient({
    fetchImpl: (async () => new Response("[]", { status: 200, headers: { Link: link } })) as typeof fetch,
  }).request({ method: "GET", path: "/repos/cat-cave/app/issues", token: "t", retryTransient: false });
it("extracts a scoped next link and rejects ambiguous relations", async () => {
  const target = "/repos/cat-cave/app/issues?state=open&per_page=50&page=2";
  expect((await request(`<${target}>; rel="prev next"`)).nextPagePath).toBe(target);
  await expect(request(`<${target}>; rel=next; rel=prev`)).rejects.toThrow(/duplicate parameter/u);
});
