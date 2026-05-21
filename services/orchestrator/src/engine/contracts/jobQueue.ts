export interface JobEnvelope<TPayload = unknown> {
  id: string;
  runId?: string;
  taskKind: string;
  payload: TPayload;
}

export interface JobQueue<TPayload = unknown> {
  enqueue(job: Omit<JobEnvelope<TPayload>, "id">): Promise<JobEnvelope<TPayload>>;
  claim(taskKind: string): Promise<JobEnvelope<TPayload> | undefined>;
  complete(id: string): Promise<void>;
}

export class FakeJobQueue<TPayload = unknown> implements JobQueue<TPayload> {
  private readonly jobs: Array<JobEnvelope<TPayload>> = [];

  async enqueue(job: Omit<JobEnvelope<TPayload>, "id">): Promise<JobEnvelope<TPayload>> {
    const envelope = { ...job, id: `job_${this.jobs.length + 1}` };
    this.jobs.push(envelope);
    return envelope;
  }

  async claim(taskKind: string): Promise<JobEnvelope<TPayload> | undefined> {
    return this.jobs.find((job) => job.taskKind === taskKind);
  }

  async complete(id: string): Promise<void> {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index >= 0) {
      this.jobs.splice(index, 1);
    }
  }
}
