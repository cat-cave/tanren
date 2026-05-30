// Shared CLI argument parsing helpers used by the P2A-0013 commands.

export type ParsedArgs = Record<string, string | string[] | undefined> & { _: string[] };

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "json") {
      args[key] = "true";
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      // Boolean flag: e.g. --json
      args[key] = "true";
      continue;
    }
    addArg(args, key, value);
    index += 1;
  }
  return args;
}

export function addArg(args: ParsedArgs, key: string, value: string): void {
  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    args[key] = [existing, value];
  }
}

export function required(args: ParsedArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new TypeError(`missing --${key}`);
  }
  return value;
}

export function optional(args: ParsedArgs, key: string): string | undefined {
  const value = args[key];
  if (Array.isArray(value)) {
    throw new TypeError(`--${key} can only be provided once`);
  }
  return value;
}

export function jsonOutput(args: ParsedArgs, payload: unknown): void {
  // Both modes emit JSON today; --json is reserved for future text mode.
  const isJsonFlag = optional(args, "json") === "true";
  if (isJsonFlag || !isJsonFlag) {
    console.log(JSON.stringify(payload, null, 2));
  }
}
