const workspaceRoot = "/workspace/runs";
const safeRunIdPattern = /^run_[A-Za-z0-9_-]+$/;

export function workspaceRepoPathForRun(runId: string): string {
  if (!safeRunIdPattern.test(runId)) {
    throw new Error(`unsafe run id for workspace path: ${runId}`);
  }
  return `${workspaceRoot}/${runId}/repo`;
}
