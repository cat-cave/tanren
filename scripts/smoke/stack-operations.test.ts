import { describe, expect, it } from "vitest";
import { queryCurrentDatabase } from "./stack-operations.js";

describe("active Postgres probe cancellation", () => {
  it("destroys the checked-out connection when an active query is aborted", async () => {
    const controller = new AbortController();
    let rejectQuery: ((error: Error) => void) | undefined;
    const releases: boolean[] = [];
    const client = {
      query: () =>
        new Promise<{ rows: { database_name?: unknown }[] }>((_resolve, reject) => {
          rejectQuery = reject;
        }),
      release: (destroy = false) => {
        releases.push(destroy);
        rejectQuery?.(new Error("connection destroyed"));
      },
    };
    const pool = { connect: async () => client, end: async () => {} };
    const pending = queryCurrentDatabase(pool, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("test cancellation"));
    await expect(pending).rejects.toThrow(/connection destroyed|test cancellation/u);
    expect(releases).toEqual([true]);
  });

  it("releases a completed probe normally", async () => {
    const releases: boolean[] = [];
    const pool = {
      connect: async () => ({
        query: async () => ({ rows: [{ database_name: "tanren" }] }),
        release: (destroy = false) => releases.push(destroy),
      }),
      end: async () => {},
    };
    await expect(queryCurrentDatabase(pool, new AbortController().signal)).resolves.toBe("tanren");
    expect(releases).toEqual([false]);
  });
});
