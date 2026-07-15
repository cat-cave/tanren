/** Browser wiring for the strict run-detail SSE state machine. */
import {
  acceptCosts,
  acceptDrained,
  acceptEvents,
  acceptHeartbeat,
  acceptSnapshot,
  acceptStatus,
  acceptTask,
  createRunStreamMachine,
  isTerminalRunStatus,
  renderStreamIntegrity,
  type RunStreamMachine,
} from "./runStreamMachine.js";

export {
  acceptCosts,
  acceptDrained,
  acceptEvents,
  acceptHeartbeat,
  acceptSnapshot,
  acceptStatus,
  acceptTask,
  createRunStreamMachine,
  isTerminalRunStatus,
  renderStreamIntegrity,
};
export type { RunStreamMachine, StreamIntegrity } from "./runStreamMachine.js";
export {
  commitTotals,
  CostFrameParseError,
  decimalToMicros,
  emptyTotals,
  formatMicros,
  parseCostRecord,
  parseCostRecords,
  prepareCostAppend,
  prepareCostReset,
  summarizeCostRecords,
  type CostRecordFrame,
  type CostTotalsState,
} from "./runStreamCosts.js";

const FRAME_HANDLERS = {
  snapshot: acceptSnapshot,
  status: acceptStatus,
  task: acceptTask,
  events: acceptEvents,
  costs: acceptCosts,
  heartbeat: acceptHeartbeat,
} as const;

function eventData(event: Event): unknown {
  const data = "data" in event ? (event as { data: unknown }).data : undefined;
  if (typeof data !== "string") throw new Error("SSE event data must be a string");
  return JSON.parse(data) as unknown;
}

export interface RunStreamInitDeps {
  document?: Document;
  EventSourceCtor?: typeof EventSource;
}

export function initRunStream(deps: RunStreamInitDeps = {}): void {
  const document = deps.document ?? (globalThis.document === undefined ? undefined : globalThis.document);
  if (document === undefined) return;
  const root = document.querySelector<HTMLElement>('[data-island="run-stream"]');
  if (root === null) return;
  const url = root.dataset["streamUrl"];
  if (url === undefined || url === "") return;
  const EventSourceCtor = deps.EventSourceCtor ?? globalThis.EventSource;
  if (EventSourceCtor === undefined) return;

  let machine: RunStreamMachine;
  try {
    machine = createRunStreamMachine(root);
  } catch {
    return;
  }
  const source = new EventSourceCtor(url, { withCredentials: true });
  let closeCalls = 0;
  const closeExactlyOnce = (): void => {
    if (closeCalls !== 0) return;
    closeCalls = 1;
    machine.closed = true;
    source.close();
  };

  for (const [name, handler] of Object.entries(FRAME_HANDLERS)) {
    source.addEventListener(name, (event) => {
      if (machine.closed) return;
      try {
        handler(machine, eventData(event));
      } catch {
        renderStreamIntegrity(machine, "stale", `Malformed ${name} frame from the run stream.`);
      }
    });
  }
  source.addEventListener("drained", (event) => {
    if (machine.closed) return;
    try {
      acceptDrained(machine, eventData(event));
      closeExactlyOnce();
    } catch {
      renderStreamIntegrity(machine, "stale", "The stream drain receipt did not match the observed run state.");
    }
  });
  source.addEventListener("error", () => {
    if (machine.closed) return;
    renderStreamIntegrity(
      machine,
      "unavailable",
      "The run stream is temporarily unavailable; the browser will reconnect from a fresh snapshot.",
    );
  });

  root.addEventListener("click", (clickEvent) => {
    const target = clickEvent.target;
    if (!(target instanceof HTMLElement)) return;
    const moment = target.closest<HTMLElement>("[data-rd-moment]");
    const taskId = moment?.dataset["rdMoment"];
    if (taskId === undefined || globalThis.window === undefined) return;
    const params = new URLSearchParams(globalThis.window.location.search);
    params.set("moment", taskId);
    globalThis.window.location.search = params.toString();
  });
}
