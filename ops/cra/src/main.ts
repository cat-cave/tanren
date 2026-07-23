#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { runBoundedPoll, serve } from "./service.js";

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if ((command !== "poll-once" && command !== "serve") || rest.length > 1) {
    throw new Error("usage: tanren-cra <poll-once|serve> [absolute-config-path]");
  }
  if (command === "poll-once") {
    await runBoundedPoll(rest[0]);
    return;
  }
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await serve(rest[0], controller.signal);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
