import { fakeAuditor, fakeChecker, fakePlanner } from "../providers/fake.js";

export async function executePlanTask(): Promise<string> {
  const plan = await fakePlanner.runAnswerer({ prompt: "Plan hello world", timeoutMs: 1_000 });
  return plan.subtasks[0]?.title ?? "Fake writer";
}

export async function executeCheckTask(diff: string | undefined) {
  return await fakeChecker.runAnswerer({ prompt: diff ?? "", timeoutMs: 1_000 });
}

export async function executeAuditTask() {
  return await fakeAuditor.runAnswerer({ prompt: "Audit hello world", timeoutMs: 1_000 });
}
