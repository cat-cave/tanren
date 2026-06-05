import { Client } from "ssh2";
import type { ClientChannel, ServerHostKeyAlgorithm } from "ssh2";
import type { RunnerHandle, SshRunnerHandle } from "../contracts/allocator.js";
import { asSshRunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { defineFailure } from "../failure.js";
import { buildSshExecCommand } from "./command.js";
import { hostKeyFingerprintMatches } from "./fingerprint.js";

type Ssh2Client = Pick<Client, "connect" | "destroy" | "end" | "exec" | "once" | "on">;
type Ssh2ClientFactory = () => Ssh2Client;

export interface SshCommandSubstrateOptions {
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

export class SshCommandSubstrate implements CommandSubstrate {
  private readonly clientFactory: Ssh2ClientFactory;

  constructor(
    private readonly secrets: SecretStore,
    private readonly options: SshCommandSubstrateOptions = {},
  ) {
    this.clientFactory = options.clientFactory ?? (() => new Client());
  }

  async run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    // The CommandSubstrate contract surface is the OPAQUE RunnerHandle; the SSH
    // impl narrows it to its concrete SshRunnerHandle (LOUD if a non-SSH handle is
    // ever routed here) and reads its reach fields from there.
    const target = asSshRunnerHandle(handle);
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

  private async runClient(
    target: SshRunnerHandle,
    command: RunnerCommand,
    privateKey: string,
    execCommand: string,
  ): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve) => {
      const client = this.clientFactory();
      const state: RunState = { stdout: "", stderr: "", exitCode: null, settled: false };
      let hostKeyFailure: string | undefined;

      const settle = (result: CommandResult, close: "end" | "destroy" = "end"): void => {
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
        settle(
          {
            ...this.failureResult(target, message),
            stdout: state.stdout,
            stderr: state.stderr,
            timedOut,
          },
          "destroy",
        );
      };

      state.timer = setTimeout(
        () => fail(`SSH command timed out after ${command.timeoutMs}ms`, true),
        command.timeoutMs,
      );
      client.once("ready", () => {
        client.exec(execCommand, (error, stream) => {
          if (error !== undefined) {
            fail(messageFromError(error));
            return;
          }
          this.collectStream(
            stream,
            state,
            (channelError) => fail(messageFromError(channelError)),
            () => {
              settle({
                exitCode: state.exitCode,
                stdout: state.stdout,
                stderr: state.stderr,
                signal: state.signal,
                timedOut: false,
              });
            },
          );
          if (command.stdin !== undefined) {
            stream.end(command.stdin);
          }
        });
      });
      // PERSISTENT listener (`.on`, not `.once`): ssh2 emits "error" AGAIN during
      // teardown after a pre-handshake connection loss (e.g. "Connection lost
      // before handshake" then a second protocol error once `client.destroy()`
      // runs in settle()). With `.once` that second emission has no listener and
      // Node's EventEmitter throws an unhandled "error" → the whole control plane
      // exits(1) on a single transient SSH blip. The `state.settled` guard makes a
      // repeat invocation a harmless no-op, so we keep listening and swallow it.
      // A long-lived listener on a destroyed client is fine — it is GC'd with the
      // client when this run's promise settles.
      client.on("error", (error: Error) => fail(hostKeyFailure ?? messageFromError(error)));
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
          this.options.serverHostKeyAlgorithms === undefined
            ? undefined
            : { serverHostKey: this.options.serverHostKeyAlgorithms },
      });
    });
  }

  private collectStream(
    stream: ClientChannel,
    state: RunState,
    onError: (error: unknown) => void,
    onClose: () => void,
  ): void {
    stream.on("data", (chunk: Buffer) => {
      state.stdout += chunk.toString("utf8");
    });
    stream.stderr.on("data", (chunk: Buffer) => {
      state.stderr += chunk.toString("utf8");
    });
    stream.on("error", onError);
    stream.stderr.on("error", onError);
    stream.once("exit", (code: number | null, signal?: string) => {
      state.exitCode = code;
      state.signal = signal;
    });
    stream.once("close", onClose);
  }

  private failureResult(target: SshRunnerHandle, message: string): CommandResult {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      failure: defineFailure({ kind: "ssh_failed", target: formatTarget(target), message }),
    };
  }
}

function formatTarget(target: SshRunnerHandle): string {
  return `${target.username}@${target.host}:${target.port}`;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
