import { Client } from "ssh2";
import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type ReleaseReason,
  type RunnerAllocation,
  type SshRunnerHandle,
} from "../contracts/allocator.js";
import { normalizeHostKeyFingerprint } from "../ssh/fingerprint.js";
import { withSshTransientRetry } from "../ssh/transientRetry.js";
import { createLogger } from "../observability/logger.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "static-runner";
const log = createLogger("static-runner");

export interface StaticRunnerAllocatorOptions {
  /** Hostname or IP the orchestrator should SSH to. */
  host: string;
  /** SSH port the orchestrator should connect to. */
  port: number;
  /** SSH username on the static runner container. */
  username?: string;
  /**
   * Pre-known SHA256 host key fingerprint of the static runner. When unset
   * (the dev-compose default), the allocator does a fresh TOFU handshake on
   * every allocate to discover the current host key — the static runner
   * regenerates host keys on each container restart.
   */
  hostKeyFingerprint?: string;
  /** Orchestrator mirror of the runners table. */
  runners: RunnerStore;
  /**
   * The ssh2 `readyTimeout` (handshake-establishment bound) for the TOFU discovery
   * handshake. This is doctrine-blessed (per `timeout-eradication.md` KEEP set): a
   * connect-establishment bound on a discrete one-shot handshake whose API gives only
   * `ready` / `error` outcomes — it cannot truncate legitimate running work because
   * there IS no running work after `ready`. Defaults to 10s.
   */
  readyTimeoutMs?: number;
  /** Override for tests. */
  clientFactory?: () => Pick<Client, "connect" | "destroy" | "end" | "once" | "on">;
  /**
   * Override the transient-retry sleep (tests inject a no-wait sleep). Plumbed straight
   * into `withSshTransientRetry`'s convergence-based retry helper as `sleep`.
   */
  retrySleep?: (ms: number) => Promise<void>;
}

/**
 * Allocator that hands back a fixed SSH target backed by the dev-compose
 * static runner service. This preserves the security boundary
 * (orchestrator has no Docker socket) while keeping `just smoke` working
 * against the static `runner` container at port 22 inside the compose
 * network. Production deployments use the SidecarHttpAllocator instead.
 *
 * Host key fingerprint discovery uses a TOFU SSH handshake on each
 * allocation: the static runner regenerates host keys on every restart, so
 * the orchestrator cannot rely on a baked-in fingerprint.
 */
export class StaticRunnerAllocator implements Allocator {
  private readonly clientFactory: () => Pick<Client, "connect" | "destroy" | "end" | "once" | "on">;

  constructor(private readonly options: StaticRunnerAllocatorOptions) {
    this.clientFactory = options.clientFactory ?? (() => new Client());
  }

  /**
   * Resolve the SSH handle to the shared static runner WITHOUT claiming a runner
   * row. The host-key fingerprint is the configured one, else a fresh per-call TOFU
   * discovery (the static runner regenerates host keys on each restart). Used both
   * by `allocate` and by the run-sandbox REAPER, which needs to reach the SAME
   * long-lived runner to sweep its `/workspace/runs/*` but is not a run allocation
   * (so it persists no row).
   */
  async resolveTarget(identitySecretRef: string): Promise<SshRunnerHandle> {
    const host = this.options.host;
    const port = this.options.port;
    const username = this.options.username ?? "tanren";
    const fingerprint = this.options.hostKeyFingerprint ?? (await this.discoverHostKeyFingerprint(host, port));
    return sshRunnerHandle({ host, port, username, hostKeyFingerprint: fingerprint, identitySecretRef });
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const target = await this.resolveTarget(request.identitySecretRef);
    const runnerId = `runner_${request.runId}`;
    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:static`,
      target,
    };

    await this.options.runners.claim({
      runnerId,
      // Persist FK-valid (run_id, project_id), or NULLs for a runless Forge
      // ideation allocation whose synthetic handle is not a real run/project.
      ...persistedRunnerKeys(request),
      orgId: request.orgId ?? null,
      allocator: allocatorName,
      sshHost: target.host,
      sshPort: target.port,
      hostKeyFingerprint: target.hostKeyFingerprint,
      imageSha: allocation.imageSha,
      containerId: runnerId,
    });

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    // The static runner is shared and long-lived; we never destroy it. Only
    // clear the orchestrator mirror row so the runners table reflects the
    // released state.
    await this.options.runners.release(runnerId);
  }

  /**
   * Discover the runner's host-key fingerprint, RETRYING transient network blips. The
   * static runner regenerates host keys per restart, so this opens a raw SSH connection on
   * every allocate (TOFU); a momentary `read ECONNRESET` (the runner briefly unavailable /
   * a reset mid-handshake) is a TRANSIENT failure that must NOT fail the allocate — it is
   * retried with bounded backoff (the apex-v35 false-escalation root cause). A genuine
   * non-transient failure (auth, an unparseable fingerprint) still fails loud on the first
   * attempt; exhausting the retries surfaces the real underlying cause (no silent fallback).
   */
  private async discoverHostKeyFingerprint(host: string, port: number): Promise<string> {
    return await withSshTransientRetry(() => this.discoverHostKeyFingerprintOnce(host, port), {
      ...(this.options.retrySleep !== undefined && { sleep: this.options.retrySleep }),
      onRetry: ({ attempt, delayMs, error }) => {
        log.warn("static runner host key discovery hit a transient network error; retrying with backoff", {
          host,
          port,
          attempt,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  private async discoverHostKeyFingerprintOnce(host: string, port: number): Promise<string> {
    const readyTimeoutMs = this.options.readyTimeoutMs ?? 10_000;
    return await new Promise<string>((resolve, reject) => {
      const client = this.clientFactory();
      let captured: string | undefined;
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          client.destroy();
        } catch {
          // ignore
        }
        action();
      };
      const finishWithCapture = (): void => {
        if (captured === undefined) {
          settle(() => reject(new Error("static runner host key discovery completed without a fingerprint")));
          return;
        }
        const normalized = normalizeHostKeyFingerprint(captured);
        if (normalized === undefined) {
          settle(() => reject(new Error(`static runner returned unparseable fingerprint: ${captured}`)));
          return;
        }
        const sha256Base64 = Buffer.from(normalized, "hex").toString("base64").replace(/=+$/u, "");
        settle(() => resolve(`SHA256:${sha256Base64}`));
      };
      // PERSISTENT listener (`.on`, not `.once`): the discovery handshake
      // intentionally aborts after the host key is captured (we have no identity
      // to authenticate with), and ssh2 emits "error" both for that intended
      // abort AND a second time during teardown — likewise for a pre-handshake
      // "Connection lost before handshake" blip, where destroy() re-emits. With
      // `.once` that second emission has no listener and Node's EventEmitter
      // throws an unhandled "error" → the orchestrator exits(1). The `settled`
      // guard makes a repeat invocation a no-op, so we keep listening and swallow
      // any follow-up error. The listener is GC'd with the client once allocate()
      // settles.
      client.on("error", (error: Error) => {
        if (captured !== undefined) {
          finishWithCapture();
          return;
        }
        settle(() => reject(new Error(`static runner host key discovery failed: ${error.message}`)));
      });
      // A clean `end` / `close` without an intervening `error` is the "the connection
      // tore down before the host key landed" case — settle via finishWithCapture so the
      // promise never wedges (with the outer wall-clock timer deleted per task #32, this
      // is the SOLE no-fingerprint terminal path that would otherwise leave the loop
      // hanging waiting for an `error` that never fires).
      client.on("end", () => {
        finishWithCapture();
      });
      client.connect({
        host,
        port,
        username: "tanren",
        // No private key: the handshake terminates after host key verification.
        hostHash: "sha256",
        hostVerifier: (fingerprint: string) => {
          captured = fingerprint;
          // Reject the connection — we only needed the host key. ssh2 will
          // fire an "error" event next; the handler above promotes it into a
          // successful finish.
          return false;
        },
        // The ssh2 `readyTimeout` is the SOLE bound on this discovery op (a
        // connect-establishment bound on this one-shot TOFU handshake — doctrine-blessed
        // per `timeout-eradication.md` KEEP set: a discrete handshake whose API gives
        // only `ready` / `error` outcomes, so a connect-establishment bound cannot
        // truncate legitimate running work — there IS no running work after `ready`).
        // The outer `setTimeout` wall-clock guard that used to wrap this was a
        // redundant disguised-deadline (task #32, critic-arc R1 #3 / R2) and is gone.
        // We omit ssh2's `timeout` option (a socket-LIFETIME idle timeout — banned by
        // the eradication lint after #638).
        readyTimeout: readyTimeoutMs,
      });
    });
  }
}
