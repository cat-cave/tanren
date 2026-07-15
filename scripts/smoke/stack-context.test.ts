import { describe, expect, it } from "vitest";

// cspell:ignore PGOPTIONS
import {
  createStackContext,
  environmentForContext,
  parseComposePort,
  probeBindings,
  requestedOffset,
  resolveHostPorts,
} from "./stack-context.js";

const HEAD = "1".repeat(40);
const TREE = "2".repeat(40);

function context(runId = "run-a", nonce = "3".repeat(32)) {
  return createStackContext({
    root: "/repo/worktree-a",
    head: HEAD,
    tree: TREE,
    runId,
    nonce,
    runtimeBase: "/runtime",
    receiptPath: `/receipts/${runId}.json`,
    ports: resolveHostPorts({}, 1200),
  });
}

describe("smoke stack context", () => {
  it("overwrites poisoned ambient targets with the candidate endpoints", () => {
    const candidate = context();
    const env = environmentForContext(
      candidate,
      {
        TANREN_PUBLIC_BASE_URL: "http://127.0.0.1:3100",
        TANREN_DASHBOARD_URL: "http://127.0.0.1:3000",
        DATABASE_URL: "postgres://decoy@127.0.0.1:5432/tanren",
        VAULT_ADDR: "http://127.0.0.1:18200",
        TANREN_CLAIM_ENDPOINT_SMOKE_URL: "https://127.0.0.1:3110",
        TANREN_SSH_PORT: "2222",
        TANREN_MTLS_DIR: "/runtime/decoy-mtls",
        TANREN_DATA_PLANE_REMOTE_WRITES: "0",
        TANREN_FLY_IMAGE_BUILDER: "1",
        TANREN_NTFY_BASE_URL: "https://decoy.invalid",
        BASH_ENV: "/tmp/poison-bash-env",
        ENV: "/tmp/poison-posix-env",
        GIT_DIR: "/tmp/decoy.git",
        DOCKER_HOST: "tcp://decoy.invalid:2375",
        DOCKER_TLS_VERIFY: "1",
        COMPOSE_FILE: "/tmp/decoy.yml",
        PODMAN_CONNECTIONS_CONF: "/tmp/decoy-podman",
        BUILDKIT_HOST: "tcp://decoy.invalid:1234",
        PGOPTIONS: "--search_path=decoy",
        HTTPS_PROXY: "http://proxy.invalid",
        NO_PROXY: "*",
        TANREN_RUNTIME_DIR: "/tmp/ambient-runtime",
      },
      "/tmp/clean-head",
    );

    expect(env["TANREN_PUBLIC_BASE_URL"]).toBe("http://127.0.0.1:4300");
    expect(env["TANREN_DASHBOARD_URL"]).toBe("http://127.0.0.1:4200");
    expect(env["DATABASE_URL"]).toContain("127.0.0.1:6632");
    expect(env["VAULT_ADDR"]).toBe("http://127.0.0.1:19400");
    expect(env["TANREN_CLAIM_ENDPOINT_SMOKE_URL"]).toBe("https://127.0.0.1:4310");
    expect(env["TANREN_SSH_PORT"]).toBe("3422");
    expect(env["COMPOSE_PROJECT_NAME"]).toBe(candidate.project);
    expect(env["TANREN_RUNTIME_DIR"]).toBe(candidate.runtimeDir);
    expect(env["TANREN_MTLS_DIR"]).toBe(`${candidate.runtimeDir}/mtls`);
    expect(env["TANREN_DATA_PLANE_REMOTE_WRITES"]).toBe("1");
    expect(env["TANREN_FLY_IMAGE_BUILDER"]).toBe("0");
    expect(env["TANREN_NTFY_BASE_URL"]).toBe("http://ntfy:80");
    expect(env["BASH_ENV"]).toBeUndefined();
    expect(env["ENV"]).toBeUndefined();
    expect(env["GIT_DIR"]).toBeUndefined();
    expect(env["DOCKER_HOST"]).toBeUndefined();
    expect(env["DOCKER_TLS_VERIFY"]).toBeUndefined();
    expect(env["COMPOSE_FILE"]).toBeUndefined();
    expect(env["PODMAN_CONNECTIONS_CONF"]).toBeUndefined();
    expect(env["BUILDKIT_HOST"]).toBeUndefined();
    expect(env["PGOPTIONS"]).toBeUndefined();
    expect(env["HTTPS_PROXY"]).toBeUndefined();
    expect(env["NO_PROXY"]).toBe("127.0.0.1,localhost,::1");
  });

  it("gives concurrent worktrees distinct projects and credential roots", () => {
    const first = context("identical-external-id", "1".repeat(32));
    const second = context("identical-external-id", "2".repeat(32));
    expect(first.project).not.toBe(second.project);
    expect(first.runtimeDir).not.toBe(second.runtimeDir);
    expect(first.buildId).not.toBe(second.buildId);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("binds every probe to shifted candidate ports, never default decoy ports", () => {
    const bindings = probeBindings(context());
    expect(bindings).toMatchObject({
      orchestrator: "http://127.0.0.1:4300/healthz",
      dashboard: "http://127.0.0.1:4200/healthz",
      allocator: "http://127.0.0.1:4400/healthz",
      vault: "http://127.0.0.1:19400/v1/sys/health",
      postgres: "127.0.0.1:6632",
      ssh: "127.0.0.1:3422",
      mtls: "https://127.0.0.1:4310",
    });
    expect(JSON.stringify(bindings)).not.toMatch(/(?:localhost|127\.0\.0\.1):(3100|3110|3000|3200|5432|2222|18200)/u);
  });

  it("parses Docker and Podman compose port output without accepting ambiguity", () => {
    expect(parseComposePort("0.0.0.0:4300\n")).toBe(4300);
    expect(parseComposePort("[::]:4300\n")).toBe(4300);
    expect(parseComposePort("127.0.0.1:4300\n0.0.0.0:4300\n")).toBe(4300);
    expect(() => parseComposePort("0.0.0.0:4300\n0.0.0.0:3100\n")).toThrow(/expected one compose host port/u);
    expect(() => parseComposePort("not-a-binding\n")).toThrow(/could not parse/u);
  });

  it("accepts Podman Compose's bare decimal published host port and keeps failing closed", () => {
    expect(parseComposePort("46673\n")).toBe(46673);
    expect(parseComposePort("46673")).toBe(46673);
    expect(parseComposePort("46673\n46673\n")).toBe(46673);
    expect(() => parseComposePort("0\n")).toThrow(/1\.\.65535/u);
    expect(() => parseComposePort("99999\n")).toThrow(/1\.\.65535/u);
    expect(() => parseComposePort("46673\n3100\n")).toThrow(/expected one compose host port/u);
    expect(() => parseComposePort("0x10\n")).toThrow(/could not parse/u);
    expect(() => parseComposePort("port-46673\n")).toThrow(/could not parse/u);
    expect(() => parseComposePort("not-a-binding:46673\n")).toThrow(/could not parse/u);
    expect(() => parseComposePort(":46673\n")).toThrow(/could not parse/u);
    expect(() => parseComposePort("http://decoy:46673\n")).toThrow(/could not parse/u);
    expect(() => parseComposePort("localhost:46673\n")).toThrow(/could not parse/u);
    expect(() => parseComposePort("::1:46673\n")).toThrow(/could not parse/u);
    expect(() => parseComposePort("[not-ipv6]:46673\n")).toThrow(/could not parse/u);
    expect(() => parseComposePort("0.0.0.0:0\n")).toThrow(/1\.\.65535/u);
    expect(() => parseComposePort("[::]:65536\n")).toThrow(/1\.\.65535/u);
  });

  it("honors only explicit port controls and rejects collisions", () => {
    const ports = resolveHostPorts({ TANREN_ORCHESTRATOR_HOST_PORT: "4545" }, 1200);
    expect(ports.orchestrator).toBe(4545);
    expect(ports.postgres).toBe(6632);
    expect(() =>
      resolveHostPorts({ TANREN_ORCHESTRATOR_HOST_PORT: "4545", TANREN_INTERNAL_MTLS_HOST_PORT: "4545" }, 1200),
    ).toThrow(/collide/u);
  });

  it("uses an explicit offset verbatim and derives a bounded one otherwise", () => {
    expect(requestedOffset({ TANREN_PORT_OFFSET: "1200" }, "run")).toBe(1200);
    expect(requestedOffset({}, "same-run")).toBe(requestedOffset({}, "same-run"));
    expect(requestedOffset({}, "same-run")).toBeGreaterThanOrEqual(1000);
    expect(requestedOffset({}, "same-run")).toBeLessThan(21_000);
    expect(() => requestedOffset({ TANREN_PORT_OFFSET: "-1" }, "run")).toThrow(/non-negative integer/u);
  });
});
