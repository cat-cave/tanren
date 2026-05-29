// Capture everything a CLI command prints to stdout while it runs, so tests can
// assert on the OBSERVABLE result the user sees rather than on `console.log`
// call counts. The captured lines are returned joined, mirroring terminal
// output; most commands print a single pretty-printed JSON document.

import { vi } from "vitest";

export interface CapturedRun {
  /** All `console.log` output, newline-joined in print order. */
  stdout: string;
  /** Convenience parse of the stdout as JSON (commands print JSON). */
  json: () => unknown;
}

export async function captureStdout(run: () => Promise<void>): Promise<CapturedRun> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  const stdout = lines.join("\n");
  return {
    stdout,
    json: () => JSON.parse(stdout) as unknown,
  };
}
