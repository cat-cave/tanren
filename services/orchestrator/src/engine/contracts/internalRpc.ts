export interface RunRequest {
  specId: string;
  projectId: string;
}

export interface RunResponse {
  runId: string;
  status: "queued" | "running" | "done" | "failed";
}

export interface InternalOrchestratorRpc {
  createRun(request: RunRequest): Promise<RunResponse>;
  getRun(runId: string): Promise<RunResponse | undefined>;
}

export class FakeInternalOrchestratorRpc implements InternalOrchestratorRpc {
  private readonly runs = new Map<string, RunResponse>();

  async createRun(request: RunRequest): Promise<RunResponse> {
    const response = { runId: `run_${request.specId}_${request.projectId}`, status: "queued" as const };
    this.runs.set(response.runId, response);
    return response;
  }

  async getRun(runId: string): Promise<RunResponse | undefined> {
    return this.runs.get(runId);
  }
}
