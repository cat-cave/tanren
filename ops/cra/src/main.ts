#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { pollOnce } from "./pollOnce.js";

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== "poll-once" || rest.length > 1) {
    throw new Error("usage: tanren-cra poll-once [absolute-config-path]");
  }
  const result = await pollOnce(rest[0]);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
