import { describe, expect, it } from "vitest";
import {
  composeLogCapture,
  composeWrapperFalseSuccess,
  queryCurrentDatabase,
  REBIND_SERVICES,
} from "./stack-operations.js";
import type { RuntimeProvider } from "./stack-runtime.js";

// Mirrors the real compose CLIs at the provider boundary (verified against the
// local podman/docker `compose --help` dumps, not the 8b5cbda receipt alone).
// docker compose `logs` accepts the subcommand flag --no-color. podman-compose
// (1.x) REJECTS --no-color as "unrecognized arguments"; `podman compose` exposes
// `--no-ansi` as its own GLOBAL option (before the subcommand), so that is the
// valid spelling used for podman. These two grammars are the negative control
// that reproduces the real provider behavior without running containers.
const COMPOSE_GLOBAL_FLAGS: Record<RuntimeProvider, ReadonlySet<string>> = {
  docker: new Set<string>(),
  podman: new Set(["--no-ansi", "--no-cleanup", "--dry-run", "--podman-args"]),
};
const LOGS_SUBCOMMAND_FLAGS: Record<RuntimeProvider, ReadonlySet<string>> = {
  docker: new Set(["--no-color", "--tail", "--since", "--until", "--follow", "--timestamps"]),
  podman: new Set(["--tail", "--since", "--until", "--follow", "--timestamps"]),
};

function flagName(arg: string): string {
  return arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
}

function everyFlagAllowed(args: readonly string[], allowed: ReadonlySet<string>): boolean {
  return args.every((arg) => !arg.startsWith("-") || allowed.has(flagName(arg)));
}

describe("active Postgres probe cancellation", () => {
  it("destroys the checked-out connection when an active query is aborted", async () => {
    const controller = new AbortController();
    let rejectQuery: ((error: Error) => void) | undefined;
    const releases: boolean[] = [];
    const client = {
      query: () =>
        new Promise<{ rows: { database_name?: unknown }[] }>((_resolve, reject) => {
          rejectQuery = reject;
        }),
      release: (destroy = false) => {
        releases.push(destroy);
        rejectQuery?.(new Error("connection destroyed"));
      },
    };
    const pool = { connect: async () => client, end: async () => {} };
    const pending = queryCurrentDatabase(pool, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("test cancellation"));
    await expect(pending).rejects.toThrow(/connection destroyed|test cancellation/u);
    expect(releases).toEqual([true]);
  });

  it("releases a completed probe normally", async () => {
    const releases: boolean[] = [];
    const pool = {
      connect: async () => ({
        query: async () => ({ rows: [{ database_name: "tanren" }] }),
        release: (destroy = false) => releases.push(destroy),
      }),
      end: async () => {},
    };
    await expect(queryCurrentDatabase(pool, new AbortController().signal)).resolves.toBe("tanren");
    expect(releases).toEqual([false]);
  });
});

describe("provider-aware compose log capture", () => {
  it("reproduces podman-compose rejecting --no-color while docker still accepts it (8b5cbda receipt)", () => {
    // The exact failing args from the receipt: `logs --no-color --tail 200`.
    expect(everyFlagAllowed(["--no-color", "--tail", "200"], LOGS_SUBCOMMAND_FLAGS.podman)).toBe(false);
    expect(everyFlagAllowed(["--no-color", "--tail", "200"], LOGS_SUBCOMMAND_FLAGS.docker)).toBe(true);
  });

  it("splits color suppression by provider: docker --no-color subcommand flag, podman --no-ansi global option", () => {
    const docker = composeLogCapture("docker", 200);
    const podman = composeLogCapture("podman", 200);
    // docker suppresses color via the valid `logs` subcommand flag --no-color.
    expect(docker.globalFlags).toEqual([]);
    expect(docker.args).toEqual(["--no-color", "--tail", "200"]);
    // podman suppresses color via the valid `podman compose` global option --no-ansi
    // (placed before `logs`); --no-color is rejected by podman-compose's logs subcommand.
    expect(podman.globalFlags).toEqual(["--no-ansi"]);
    expect(podman.args).toEqual(["--tail", "200"]);
    // Both buckets are valid for their provider's grammar.
    expect(everyFlagAllowed(docker.globalFlags, COMPOSE_GLOBAL_FLAGS.docker)).toBe(true);
    expect(everyFlagAllowed(docker.args, LOGS_SUBCOMMAND_FLAGS.docker)).toBe(true);
    expect(everyFlagAllowed(podman.globalFlags, COMPOSE_GLOBAL_FLAGS.podman)).toBe(true);
    expect(everyFlagAllowed(podman.args, LOGS_SUBCOMMAND_FLAGS.podman)).toBe(true);
    // Capture stays bounded and never follows (no --follow / -f).
    expect([...docker.globalFlags, ...docker.args]).not.toContain("--follow");
    expect([...podman.globalFlags, ...podman.args]).not.toContain("--follow");
  });

  it("pins the global-before-logs argument ordering the stage emits", () => {
    // Reconstruct exactly what capture-compose-logs passes to composeArgs:
    //   composeArgs(ctx, ...globalFlags, "logs", ...args)
    // i.e. globalFlags land before `logs`, subcommand args after.
    for (const provider of ["docker", "podman"] as const) {
      const capture = composeLogCapture(provider, 200);
      const ordered = [...capture.globalFlags, "logs", ...capture.args];
      const logsIndex = ordered.indexOf("logs");
      expect(logsIndex).toBeGreaterThan(-1);
      const beforeLogs = ordered.slice(0, logsIndex);
      const afterLogs = ordered.slice(logsIndex + 1);
      // Every global flag is a valid provider global option that precedes `logs`.
      expect(everyFlagAllowed(beforeLogs, COMPOSE_GLOBAL_FLAGS[provider])).toBe(true);
      // Every subcommand flag is a valid `logs` option that follows `logs`.
      expect(everyFlagAllowed(afterLogs, LOGS_SUBCOMMAND_FLAGS[provider])).toBe(true);
      // A global option must never leak after `logs`, and a subcommand option
      // (like --no-color / --tail) must never appear before it.
      for (const flag of beforeLogs) expect(afterLogs).not.toContain(flag);
      for (const flag of afterLogs.filter((arg) => arg.startsWith("-"))) expect(beforeLogs).not.toContain(flag);
    }
    // podman's --no-ansi specifically lands before `logs` (the only valid position).
    const podman = composeLogCapture("podman", 200);
    const podmanOrdered = [...podman.globalFlags, "logs", ...podman.args];
    expect(podmanOrdered.indexOf("--no-ansi")).toBeLessThan(podmanOrdered.indexOf("logs"));
  });
});

describe("compose wrapper false-success detection", () => {
  // Verbatim shape from the 8b5cbda receipt's podman-compose failure output.
  const podmanReceiptOutput =
    '>>>> Executing external compose provider "/run/current-system/sw/bin/podman-compose".\n\n' +
    "podman-compose: error: unrecognized arguments: --no-color\n" +
    "Error: executing /run/current-system/sw/bin/podman-compose: exit status 2";

  it("detects a wrapper that printed a hard-failure line but exited 0", () => {
    const detected = composeWrapperFalseSuccess("podman", podmanReceiptOutput);
    expect(detected).toMatch(/compose wrapper reported an error while exiting successfully.*provider=podman/u);
    // Pin the exact captured line: the hyphenated `podman-compose: error:` line
    // (matched directly by the [\w-]*compose pattern), NOT the later
    // `Error: executing ...-compose` line that the `^Error:` fallback would catch.
    expect(detected).toContain("podman-compose: error: unrecognized arguments: --no-color");
  });

  it("does not flag clean detached-up output or empty output", () => {
    expect(
      composeWrapperFalseSuccess("docker", " Container orchestrator-1 Recreated\n Container orchestrator-1 Started"),
    ).toBeUndefined();
    expect(composeWrapperFalseSuccess("podman", "")).toBeUndefined();
  });
});

describe("rebind dependent service set", () => {
  it("recreates the orchestrator together with the services that depend on it", () => {
    expect([...REBIND_SERVICES].sort()).toEqual(["dashboard", "orchestrator", "worker"]);
  });
});
