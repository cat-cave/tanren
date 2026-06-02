// A TEST FIXTURE (tests/ only) EventStore that records appended events in memory
// so a test can assert what was emitted (and that no secret value leaked into a
// payload). Never wired into a production src/ path.

import type { EventStore as RealEventStore } from "../../src/engine/eventStore.js";

export type EventStore = RealEventStore;

export interface AppEventInputForTest {
  projectId: string;
  runId?: string;
  taskId?: string;
  specId?: string;
  eventType: string;
  payload: unknown;
}

export class FakeEventStore {
  readonly appended: AppEventInputForTest[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async append(input: AppEventInputForTest): Promise<void> {
    this.appended.push(input);
  }
}
