import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../../src/engine/contracts/commandSubstrate.js";
import { FakeEventStore } from "./fakeEventStore.js";
import { RecordingRunPool } from "./githubDraftPrFakes.js";

export class ManualRouteDurableHeadPool extends RecordingRunPool {
  publishedHead: string | undefined;
  readonly durableReads: unknown[][] = [];

  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("event_type = 'github.branch.pushed'")) {
      this.durableReads.push(params);
      return this.publishedHead === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ payload: { headSha: this.publishedHead } }], rowCount: 1 };
    }
    return await super.query(sql, params);
  }
}

export class PersistingManualEventStore extends FakeEventStore {
  constructor(private readonly pool: ManualRouteDurableHeadPool) {
    super();
  }

  override async append(input: Parameters<FakeEventStore["append"]>[0]): Promise<void> {
    await super.append(input);
    if (input.eventType === "github.branch.pushed") {
      this.pool.publishedHead = (input.payload as { headSha: string }).headSha;
    }
  }
}

export class ManualPublicationSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];

  constructor(private readonly heads: string[]) {}

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    if (command.command === "git rev-parse HEAD") {
      const head = this.heads.shift();
      if (head === undefined) throw new Error("unexpected manual workspace-head read");
      return { exitCode: 0, stdout: `${head}\n`, stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}
