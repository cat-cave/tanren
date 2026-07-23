import { randomInt } from "node:crypto";
import type { CraConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { execute, type CommandExecutor } from "./process.js";
import { pollOnce, type PollOnceResult } from "./pollOnce.js";

export class FailureNotifier {
  public constructor(
    private readonly config: CraConfig,
    private readonly executor: CommandExecutor = execute,
  ) {}

  public async notify(error: unknown): Promise<void> {
    const message = `CRA FAILURE: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    const result = await this.executor({
      command: this.config.notification.command,
      args: [...this.config.notification.args, message],
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`failure notifier exited ${result.exitCode}: ${result.stderr.trim()}`);
    }
  }
}

async function notifyFailure(configFile: string | undefined, error: unknown): Promise<void> {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  try {
    const { config } = await loadConfig(configFile);
    await new FailureNotifier(config).notify(error);
  } catch (notificationError) {
    console.error(
      `CRA FAILURE NOTIFICATION ALSO FAILED: ${
        notificationError instanceof Error ? notificationError.message : String(notificationError)
      }`,
    );
  }
}

export async function runBoundedPoll(configFile?: string): Promise<PollOnceResult> {
  try {
    const result = await pollOnce(configFile);
    console.log(JSON.stringify(result.dailyStatus));
    return result;
  } catch (error) {
    await notifyFailure(configFile, error);
    throw error;
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    // eslint-disable-next-line no-inline-comments -- architecture exemption must annotate the timer line.
    const timer = setTimeout(resolve, milliseconds); // arch-allow: timeout-class poll schedule, not progress
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function serve(configFile?: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
  const { config } = await loadConfig(configFile);
  while (!signal.aborted) {
    await runBoundedPoll(configFile);
    const jitter = config.timing.jitterSeconds === 0 ? 0 : randomInt(config.timing.jitterSeconds * 1_000 + 1);
    await delay(config.timing.pollSeconds * 1_000 + jitter, signal);
  }
}
