import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CraPaths } from "./paths.js";
import { atomicWriteFile, ensurePrivateDirectory, removeTemporarySiblings } from "./filesystem.js";
import type { SingletonLease } from "./singleton.js";
import { prStateSchema, type PrState } from "./stateSchemas.js";

export class PrStateStore {
  public constructor(
    private readonly paths: CraPaths,
    private readonly lease: SingletonLease,
  ) {}

  public async recover(): Promise<void> {
    this.lease.assertHeld();
    await ensurePrivateDirectory(this.paths.stateRoot);
    await ensurePrivateDirectory(this.paths.prsDirectory);
    await ensurePrivateDirectory(this.paths.auditsDirectory);
    await ensurePrivateDirectory(this.paths.eventsDirectory);
    await removeTemporarySiblings(this.paths.prsDirectory);
  }

  public async read(pr: number): Promise<PrState | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.pathFor(pr), "utf8"));
      return prStateSchema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async write(state: PrState): Promise<void> {
    this.lease.assertHeld();
    const validated = prStateSchema.parse(state);
    await atomicWriteFile(this.pathFor(validated.pr), `${JSON.stringify(validated, null, 2)}\n`);
  }

  private pathFor(pr: number): string {
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error(`invalid PR number: ${pr}`);
    return resolve(this.paths.prsDirectory, `${pr}.json`);
  }
}
