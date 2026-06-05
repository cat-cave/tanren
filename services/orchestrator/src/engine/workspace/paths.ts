// The runner sandbox path model. Every run executes inside
// `/workspace/runs/<runId>` on the runner host; `…/repo` is the clone+build tree
// under it. The `safeRunIdPattern` guard is LOAD-BEARING: it is the gate that
// keeps a path derived from a run id from ever escaping `/workspace/runs/` (a
// malformed id throws here rather than producing an `rm -rf`-able arbitrary path),
// and the run-workspace REAPER reuses it to refuse to delete any `/workspace/runs/*`
// entry that does not match the safe `run_*` shape.
export const WORKSPACE_RUNS_ROOT = "/workspace/runs";
export const safeRunIdPattern = /^run_[A-Za-z0-9_-]+$/u;

/** The run's sandbox ROOT dir (`/workspace/runs/<runId>`) — what end-of-run teardown removes. */
export function workspaceRunDirForRun(runId: string): string {
  if (!safeRunIdPattern.test(runId)) {
    throw new Error(`unsafe run id for workspace path: ${runId}`);
  }
  return `${WORKSPACE_RUNS_ROOT}/${runId}`;
}

/** The run's clone+build tree (`/workspace/runs/<runId>/repo`). */
export function workspaceRepoPathForRun(runId: string): string {
  return `${workspaceRunDirForRun(runId)}/repo`;
}
