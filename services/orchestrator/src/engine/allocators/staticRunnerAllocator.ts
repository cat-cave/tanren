import { Client } from "ssh2";
import type { AllocationRequest, Allocator, ReleaseReason, RunnerAllocation } from "../contracts/allocator.js";
import { normalizeHostKeyFingerprint } from "../ssh/fingerprint.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "static-runner";

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
  /** Timeout for the TOFU discovery handshake. */
  discoverTimeoutMs?: number;
  /** Override for tests. */
  clientFactory?: () => Pick<Client, "connect" | "destroy" | "end" | "once">;
}

/**
 * Allocator that hands back a fixed SSH target backed by the dev-compose
 * static runner service. This preserves the P2A-0010 security boundary
 * (orchestrator has no Docker socket) while keeping `just smoke` working
 * against the static `runner` container at port 22 inside the compose
 * network. Production deployments use the SidecarHttpAllocator instead.
 *
 * Host key fingerprint discovery uses a TOFU SSH handshake on each
 * allocation: the static runner regenerates host keys on every restart, so
 * the orchestrator cannot rely on a baked-in fingerprint.
 */
export class StaticRunnerAllocator implements Allocator {
  private readonly clientFactory: () => Pick<Client, "connect" | "destroy" | "end" | "once">;

  constructor(private readonly options: StaticRunnerAllocatorOptions) {
    this.clientFactory = options.clientFactory ?? (() => new Client());
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const host = this.options.host;
    const port = this.options.port;
    const username = this.options.username ?? "tanren";
    const fingerprint = this.options.hostKeyFingerprint ?? (await this.discoverHostKeyFingerprint(host, port));
    const runnerId = `runner_${request.runId}`;
    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:static`,
      target: {
        host,
        port,
        username,
        hostKeyFingerprint: fingerprint,
        identitySecretRef: request.identitySecretRef,
      },
    };

    await this.options.runners.claim({
      runnerId,
      runId: request.runId,
      projectId: request.projectId,
      allocator: allocatorName,
      sshHost: host,
      sshPort: port,
      hostKeyFingerprint: fingerprint,
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

  private async discoverHostKeyFingerprint(host: string, port: number): Promise<string> {
    const timeoutMs = this.options.discoverTimeoutMs ?? 10_000;
    return await new Promise<string>((resolve, reject) => {
      const client = this.clientFactory();
      let captured: string | undefined;
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
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
      const timer = setTimeout(
        () => settle(() => reject(new Error(`static runner host key discovery timed out after ${timeoutMs}ms`))),
        timeoutMs,
      );
      client.once("error", (error: Error) => {
        // The discovery handshake intentionally aborts after the host key is
        // verified — we have no identity to authenticate with. Once we have
        // captured the fingerprint any subsequent error is expected.
        if (captured !== undefined) {
          finishWithCapture();
          return;
        }
        settle(() => reject(new Error(`static runner host key discovery failed: ${error.message}`)));
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
        readyTimeout: timeoutMs,
        timeout: timeoutMs,
      });
    });
  }
}
