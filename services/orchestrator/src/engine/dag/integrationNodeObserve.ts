// Observe-only node UPSERT + §8 compatibility projection (split from integrationNodesPg).

import { type AncestorStack } from "./ancestorStack.js";
import { upsertIntegrationNodeOnClient, type QueryRunner } from "./integrationNodesPg.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("integration-nodes");

/**
 * The OBSERVE-ONLY write hook the run-create path calls. Given the run being
 * inserted (on its already org-scoped, in-tx client), ADDITIVELY UPSERT the
 * `integration_nodes` row that mirrors it — derived from the SAME speculative base
 * + ancestor head SHAs the run row records, via the pure `memberKey`. A
 * non-speculative run (no base, no ancestors) is a node with ZERO members — still a
 * node (the unified model: one run, base may shift), so it is recorded too.
 *
 * SAVEPOINT-ISOLATED so it can NEVER fail a run. This runs INSIDE the run-create
 * transaction, and in Postgres ANY statement error POISONS the whole tx ("current
 * transaction is aborted") — a bare try/catch does NOT save the subsequent
 * spec/task/job/event writes, which would then fail and FAIL THE RUN. So the observe
 * write is wrapped in a SAVEPOINT: on ANY error we `ROLLBACK TO SAVEPOINT` (which
 * un-poisons the tx back to the savepoint) and swallow it, leaving the outer tx
 * clean to commit the real run. No reads drive behavior; this is pure observation.
 *
 * The org is read back from the just-inserted run row on the SAME scoped client
 * (the INSERT derived `org_id` from the project) so the UPSERT carries the exact
 * tenant key. A null-org (CLI) run is SKIPPED (nothing to scope a tenant write to).
 */
export async function observeRunAsIntegrationNode(
  client: QueryRunner,
  // structural to avoid coupling this dag module to the workflow types).
  run: { runId: string; specId: string; branch: string; projectId: string; project: { defaultBranch: string } },
  // the jj-local model the eager dependent's base is `main + ordered ancestor_stack`
  // (no synthesized host ref), so the node is derived from the ordered `ancestorStack`.
  spec: { ancestorStack?: AncestorStack } | undefined,
): Promise<void> {
  // rolls the tx back to HERE, so the outer run-create tx stays committable.
  await client.query("SAVEPOINT obs_node");
  try {
    const orgResult = await client.query<{ org_id: string | null }>("SELECT org_id FROM runs WHERE run_id = $1", [
      run.runId,
    ]);
    const orgId = orgResult.rows[0]?.org_id ?? null;
    // A null-org (CLI) run has no tenant key to scope a write to — skip it (but still
    // RELEASE the savepoint below so the tx has no dangling savepoint).
    if (orgId !== null) {
      const baseBranch = run.project.defaultBranch;
      // jj-local: the dependent assembles `main + ordered ancestors` LOCALLY; the run
      // row never persists the assembled `main` SHA, so the base identity is the default
      // branch name. The bootstrap's `eager_base` UPSERT (PR-8) records the materialized
      // head + the full member shas; this observe-at-create node is the placeholder.
      const baseSha = baseBranch;
      const members = (spec?.ancestorStack ?? []).map((member) => ({
        specId: member.specId,
        runId: member.runId === "" ? run.runId : member.runId,
        branch: member.branch === "" ? member.specId : member.branch,
        headSha: member.headSha,
      }));
      await upsertIntegrationNodeOnClient(client, {
        projectId: run.projectId,
        orgId,
        baseBranch,
        baseSha,
        // bootstrap `eager_base` UPSERT records the real LOCAL assembly bookmark).
        ref: run.branch,
        // eager dependent's dynamic base when speculative; else a (zero-member) node
        // against `main`. The purpose only LABELS intent — it never branches control.
        purpose: "eager_base",
        members,
        status: "building",
      });
    }
    // Success (or a benign null-org skip): RELEASE the savepoint, keeping the node
    // write part of the outer tx's commit.
    await client.query("RELEASE SAVEPOINT obs_node");
  } catch (error) {
    // OBSERVE-ONLY: a node-write failure must NEVER fail a run. ROLLBACK TO the
    // savepoint FIRST — this un-poisons the aborted tx so the run-create's remaining
    // writes succeed — then RELEASE it and swallow the error. The ROLLBACK is the
    // load-bearing fix; the log is for visibility.
    await client.query("ROLLBACK TO SAVEPOINT obs_node").catch(() => {});
    await client.query("RELEASE SAVEPOINT obs_node").catch(() => {});
    log.warn("observe-only node UPSERT failed (non-fatal)", { runId: run.runId }, error);
  }
}
