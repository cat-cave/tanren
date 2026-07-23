import { open, readFile, truncate } from "node:fs/promises";
import { resolve } from "node:path";
import type { CraPaths } from "./paths.js";
import { ensurePrivateDirectory } from "./filesystem.js";
import type { SingletonLease } from "./singleton.js";
import { eventSchema, type CraEvent } from "./stateSchemas.js";

export class EventLog {
  public constructor(
    private readonly paths: CraPaths,
    private readonly lease: SingletonLease,
  ) {}

  public async recover(date: string): Promise<void> {
    this.lease.assertHeld();
    const path = this.pathFor(date);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let cursor = 0;
    while (cursor < contents.length) {
      const newline = contents.indexOf("\n", cursor);
      const hasNewline = newline !== -1;
      const line = contents.slice(cursor, hasNewline ? newline : undefined);
      if (line === "") throw new Error(`event log contains a blank record: ${path}`);
      try {
        eventSchema.parse(JSON.parse(line));
      } catch (error) {
        if (hasNewline)
          throw new Error(`event log contains corruption before its final record: ${path}`, { cause: error });
        await this.truncateAndSync(path, Buffer.byteLength(contents.slice(0, cursor)));
        break;
      }
      if (!hasNewline) {
        const handle = await open(path, "a", 0o600);
        try {
          await handle.writeFile("\n", "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      }
      cursor = newline + 1;
    }
  }

  private async truncateAndSync(path: string, bytes: number): Promise<void> {
    await truncate(path, bytes);
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  public async append(event: CraEvent): Promise<void> {
    this.lease.assertHeld();
    const value = eventSchema.parse(event);
    const date = value.timestamp.slice(0, 10);
    await ensurePrivateDirectory(this.paths.eventsDirectory);
    await this.recover(date);
    const handle = await open(this.pathFor(date), "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private pathFor(date: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`invalid event date: ${date}`);
    return resolve(this.paths.eventsDirectory, `${date}.jsonl`);
  }
}
