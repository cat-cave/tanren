import { Client } from "ssh2";
import type { ClientChannel, ServerHostKeyAlgorithm } from "ssh2";
import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../contracts/sshSubstrate.js";
import { defineFailure } from "../failure.js";
import { buildSshExecCommand } from "./command.js";
import { hostKeyFingerprintMatches } from "./fingerprint.js";

type Ssh2Client = Pick<Client, "connect" | "destroy" | "end" | "exec" | "once">;
type Ssh2ClientFactory = () => Ssh2Client;

export interface Ssh2SubstrateOptions {
  clientFactory?: Ssh2ClientFactory;
  connectTimeoutMs?: number;
  serverHostKeyAlgorithms?: ServerHostKeyAlgorithm[];
}

interface RunState {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  settled: boolean;
  timer?: NodeJS.Timeout;
}

export class Ssh2Substrate implements SshSubstrate {
  private readonly clientFactory: Ssh2ClientFactory;

  constructor(
    private readonly secrets: SecretStore,
    private readonly options: Ssh2SubstrateOptions = {}
  ) {
    this.clientFactory = options.clientFactory ?? (() => new Client());
  }

  async run(target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    const identity = await this.secrets.get(target.identitySecretRef);
    if (identity === undefined) {
      return this.failureResult(target, `missing SSH identity secret: ${target.identitySecretRef}`);
    }

    let execCommand: string;
    try {
      execCommand = buildSshExecCommand(command);
    } catch (error) {
      return this.failureResult(target, messageFromError(error));
    }

    return await this.runClient(target, command, identity.value, execCommand);
  }

  private async runClient(target: SshTarget, command: SshCommand, privateKey: string, execCommand: string): Promise<SshCommandResult> {
    return await new Promise<SshCommandResult>((resolve) => {
      const client = this.clientFactory();
      const state: RunState = { stdout: "", stderr: "", exitCode: null, settled: false };
      let hostKeyFailure: string | undefined;

      const settle = (result: SshCommandResult, close: "end" | "destroy" = "end"): void => {
        if (state.settled) {
          return;
        }
        state.settled = true;
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
        }
        if (close === "destroy") {
          client.destroy();
        } else {
          client.end();
        }
        resolve(result);
      };

      const fail = (message: string, timedOut = false): void => {
        settle({ ...this.failureResult(target, message), stdout: state.stdout, stderr: state.stderr, timedOut }, "destroy");
      };

      state.timer = setTimeout(() => fail(`SSH command timed out after ${command.timeoutMs}ms`, true), command.timeoutMs);
      client.once("ready", () => {
        client.exec(execCommand, (error, stream) => {
          if (error !== undefined) {
            fail(messageFromError(error));
            return;
          }
          this.collectStream(stream, state, () => {
            settle({
              exitCode: state.exitCode,
              stdout: state.stdout,
              stderr: state.stderr,
              signal: state.signal,
              timedOut: false
            });
          });
        });
      });
      client.once("error", (error: Error) => fail(hostKeyFailure ?? messageFromError(error)));
      client.once("timeout", () => fail(`SSH connection timed out after ${command.timeoutMs}ms`, true));
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey,
        authHandler: ["publickey"],
        hostHash: "sha256",
        hostVerifier: (fingerprint: string) => {
          const matches = hostKeyFingerprintMatches(fingerprint, target.hostKeyFingerprint);
          if (!matches) {
            hostKeyFailure = `SSH host key fingerprint mismatch for ${formatTarget(target)}`;
          }
          return matches;
        },
        readyTimeout: this.options.connectTimeoutMs ?? command.timeoutMs,
        timeout: this.options.connectTimeoutMs ?? command.timeoutMs,
        algorithms:
          this.options.serverHostKeyAlgorithms === undefined ? undefined : { serverHostKey: this.options.serverHostKeyAlgorithms }
      });
    });
  }

  private collectStream(stream: ClientChannel, state: RunState, onClose: () => void): void {
    stream.on("data", (chunk: Buffer) => {
      state.stdout += chunk.toString("utf8");
    });
    stream.stderr.on("data", (chunk: Buffer) => {
      state.stderr += chunk.toString("utf8");
    });
    stream.once("exit", (code: number | null, signal?: string) => {
      state.exitCode = code;
      state.signal = signal;
    });
    stream.once("close", onClose);
  }

  private failureResult(target: SshTarget, message: string): SshCommandResult {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      failure: defineFailure({ kind: "ssh_failed", target: formatTarget(target), message })
    };
  }
}

function formatTarget(target: SshTarget): string {
  return `${target.username}@${target.host}:${target.port}`;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
