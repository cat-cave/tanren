// Negative row-decode tests for the draft-PR run-context load (`DraftPrRunRow`).
// `publishDraftPullRequestForRun` is the real public seam: it loads the run⋈spec⋈project
// join row and Zod-decodes it (no raw `rows[0] as …` cast). A malformed / wrong-type /
// null row must FAIL through that seam as a Zod validation error rather than slipping
// through as a partially-decoded context (a missing org_id / wrong-type ssh_port would
// crash deeper in the GitHub push or, worse, open a PR against the wrong base). Kept in
// its own file so `githubDraftPr.test.ts` (493 lines) stays under the 500-line cap.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { RecordingSsh } from "./helpers/githubDraftPrFakes.js";
import { ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";
import { publishDraftPullRequestForRun } from "../src/engine/workflow/githubDraftPr.js";

/**
 * A query-only client whose join-row read returns `row` (the malformed context). The
 * decode runs BEFORE any GitHub / SSH side-effect, so no scripted responses are needed
 * — the seam rejects at the load step.
 */
function poolReturningRunRow(row: unknown): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (sql.includes("FROM runs r") && sql.includes("JOIN projects p")) {
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query } as unknown as pg.Pool;
}

const baseInput = {
  secrets: new FakeSecretStore(),
  githubHttp: new ScriptedGitHubHttp([]),
  ssh: new RecordingSsh(),
  eventStore: new FakeEventStore(),
  identitySecretRef: "runner/local/identity",
};

describe("publishDraftPullRequestForRun — DraftPrRunRow Zod decode", () => {
  it("REJECTS a null run-context row (corruption) as a Zod failure, NOT a not-found", async () => {
    // `result.rows[0]` is null (not undefined) — a corrupted row, not a missing one.
    // The `undefined` check returns "not found"; a present-but-null row must FAIL decode.
    const pool = poolReturningRunRow(null);

    await expect(publishDraftPullRequestForRun({ ...baseInput, pool, runId: "run_corrupt" })).rejects.toThrow(
      /invalid_type/u,
    );
  });

  it("REJECTS a row whose org_id is null (NOT NULL column violated) as a Zod failure", async () => {
    const pool = poolReturningRunRow({ run_id: "run_1", spec_id: "spec_1", project_id: "p_1", org_id: null });

    await expect(publishDraftPullRequestForRun({ ...baseInput, pool, runId: "run_1" })).rejects.toThrow(
      /invalid_type/u,
    );
  });

  it("REJECTS a row whose ssh_port is a string (wrong type for number|null) as a Zod failure", async () => {
    // A well-formed row except ssh_port: "22" (string) — the LEFT JOIN LATERAL returns a
    // number or null; a string is a schema/payload corruption the decode must catch.
    const pool = poolReturningRunRow({
      run_id: "run_1",
      spec_id: "spec_1",
      project_id: "p_1",
      org_id: "org_1",
      branch: "tanren/run_1",
      ancestor_stack: null,
      repo_url: "https://github.com/cat-cave/repo.git",
      default_branch: "main",
      config: null,
      org_config: null,
      spec_title: "T",
      spec_description: "D",
      ssh_host: "runner",
      ssh_port: "22",
      host_key_fingerprint: "SHA256:x",
    });

    await expect(publishDraftPullRequestForRun({ ...baseInput, pool, runId: "run_1" })).rejects.toThrow(
      /invalid_type/u,
    );
  });

  it("REJECTS a wrong-shape row (empty object) as a Zod failure on missing required keys", async () => {
    const pool = poolReturningRunRow({});

    await expect(publishDraftPullRequestForRun({ ...baseInput, pool, runId: "run_empty" })).rejects.toThrow(
      /invalid_type/u,
    );
  });
});
