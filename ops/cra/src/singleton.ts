import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDirectory } from "./filesystem.js";

export class SingletonLease {
  private released = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  public static async acquire(lockFile: string, flockCommand = "flock"): Promise<SingletonLease> {
    await ensurePrivateDirectory(dirname(lockFile));
    const handle = await open(lockFile, "a", 0o600);
    await handle.close();
    const lockInfo = await lstat(lockFile);
    if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || (lockInfo.mode & 0o077) !== 0) {
      throw new Error(`unsafe CRA singleton lock file: ${lockFile}`);
    }
    const child = spawn(
      flockCommand,
      ["--exclusive", "--nonblock", lockFile, "sh", "-c", 'printf "LOCKED\\n"; cat >/dev/null'],
      {
        stdio: "pipe",
      },
    );
    const result = await new Promise<"locked" | "refused">((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => {
        // arch-allow: timeout-class Fail closed if the external flock handshake cannot establish a lease.
        child.kill("SIGKILL");
        reject(new Error("timed out acquiring CRA singleton lock"));
      }, 5_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("LOCKED\n")) {
          clearTimeout(timer);
          resolve("locked");
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve("refused");
      });
    });
    if (result === "refused") throw new Error(`another CRA instance holds ${lockFile}`);
    return new SingletonLease(child);
  }

  public isHeld(): boolean {
    return !this.released && this.child.exitCode === null;
  }

  public assertHeld(): void {
    if (!this.isHeld()) throw new Error("CRA singleton lease is not held");
  }

  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      this.child.once("error", reject);
      this.child.once("exit", () => resolve());
    });
  }
}
