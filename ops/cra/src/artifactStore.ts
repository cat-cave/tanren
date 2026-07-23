import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CraPaths } from "./paths.js";
import { immutableWriteFile } from "./filesystem.js";
import type { SingletonLease } from "./singleton.js";
import { auditArtifactSchema, type AuditArtifact } from "./stateSchemas.js";

function safeSegment(value: string, description: string): string {
  if (value === "." || value === ".." || !/^[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error(`invalid ${description}: ${value}`);
  }
  return value;
}

export class AuditArtifactStore {
  public constructor(
    private readonly paths: CraPaths,
    private readonly lease: SingletonLease,
  ) {}

  public async writeReport(artifact: AuditArtifact): Promise<void> {
    this.lease.assertHeld();
    const value = auditArtifactSchema.parse(artifact);
    const path = this.pathFor(value.pr, value.headSha, value.rubricVersion, "report.json");
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    if (!(await immutableWriteFile(path, contents))) {
      const existing = await readFile(path, "utf8");
      if (existing !== contents)
        throw new Error(`immutable audit artifact already exists with different content: ${path}`);
    }
  }

  public async writeWorkerLog(pr: number, headSha: string, rubricVersion: string, contents: string): Promise<void> {
    this.lease.assertHeld();
    const path = this.pathFor(pr, headSha, rubricVersion, "worker.log");
    if (!(await immutableWriteFile(path, contents))) {
      const existing = await readFile(path, "utf8");
      if (existing !== contents) throw new Error(`immutable worker log already exists with different content: ${path}`);
    }
  }

  private pathFor(pr: number, headSha: string, rubricVersion: string, file: string): string {
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error(`invalid PR number: ${pr}`);
    return resolve(
      this.paths.auditsDirectory,
      String(pr),
      safeSegment(headSha, "head SHA"),
      safeSegment(rubricVersion, "rubric version"),
      file,
    );
  }
}
