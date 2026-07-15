import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LifecycleLedger } from "./stack-lifecycle.js";
import type { PreparedSmokeRun } from "./run-stack.js";

interface BootstrapSignalState {
  name?: "SIGINT" | "SIGTERM";
  exitCode?: number;
  sealed: boolean;
}

const startedAt = new Date().toISOString();
const fallbackNonce = `bootstrap-${process.pid}`;
const fallbackReceiptPath = join(tmpdir(), "tanren-smoke-receipts", `bootstrap-${fallbackNonce}.json`);
const abortController = new AbortController();
const signalState: BootstrapSignalState = { sealed: false };

function interrupt(name: "SIGINT" | "SIGTERM", exitCode: number): void {
  if (signalState.sealed) return;
  signalState.name ??= name;
  signalState.exitCode ??= exitCode;
  if (!abortController.signal.aborted) abortController.abort(new Error(`smoke interrupted by ${name}`));
}

const onSigInt = () => interrupt("SIGINT", 130);
const onSigTerm = () => interrupt("SIGTERM", 143);
process.on("SIGINT", onSigInt);
process.on("SIGTERM", onSigTerm);

function sanitizedError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu, "<redacted-private-key>")
    .replaceAll(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/giu, "$1<redacted>@")
    .replaceAll(/(token|password|secret|key)[=:]\s*[^\s]+/giu, "$1=<redacted>")
    .slice(0, 8_192);
}

async function publishExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function receiptBelongsToRun(path: string, nonce: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { context?: { nonce?: unknown } };
    return value.context?.nonce === nonce;
  } catch {
    return false;
  }
}

async function publishBootstrapFailure(input: {
  error: unknown;
  receiptPath: string;
  nonce: string;
  head?: string;
  tree?: string;
  cleanupErrors: string[];
}): Promise<void> {
  if (signalState.sealed) return;
  const receipt = {
    status: "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    context: {
      nonce: input.nonce,
      ...(input.head === undefined ? {} : { head: input.head }),
      ...(input.tree === undefined ? {} : { tree: input.tree }),
    },
    probes: {},
    platformCredentials: "not_configured",
    cleanup: input.cleanupErrors.length === 0 ? "completed" : "partial",
    ...(input.cleanupErrors.length === 0 ? {} : { cleanupErrors: input.cleanupErrors }),
    stages: [
      {
        name: "bootstrap",
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        error: sanitizedError(input.error),
      },
    ],
    error: sanitizedError(input.error),
    keepStackAuthorized: false,
  };
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (await receiptBelongsToRun(input.receiptPath, input.nonce)) {
    signalState.sealed = true;
    return;
  }
  try {
    await publishExclusive(input.receiptPath, json);
    signalState.sealed = true;
    process.stdout.write(`smoke receipt: ${input.receiptPath}\n`);
    return;
  } catch (error) {
    input.cleanupErrors.push(`primary receipt: ${sanitizedError(error)}`);
  }
  await publishExclusive(fallbackReceiptPath, json);
  signalState.sealed = true;
  process.stdout.write(`smoke receipt: ${fallbackReceiptPath}\n`);
}

async function bootstrap(): Promise<number> {
  let nonce = fallbackNonce;
  let receiptPath = fallbackReceiptPath;
  let head: string | undefined;
  let tree: string | undefined;
  let buildBase: string | undefined;
  const cleanupErrors: string[] = [];
  let bootstrapLedger: LifecycleLedger | undefined;
  try {
    const [{ createRunNonce, createStackContext, withExecutionRoot }, { findAvailablePorts }, lifecycle, build, paths] =
      await Promise.all([
        import("./stack-context.js"),
        import("./stack-runtime.js"),
        import("./stack-lifecycle.js"),
        import("./stack-build.js"),
        import("./stack-paths.js"),
      ]);
    nonce = createRunNonce();
    bootstrapLedger = new lifecycle.LifecycleLedger(undefined, abortController);
    const candidate = await lifecycle.readCandidateIdentity(
      process.cwd(),
      process.env,
      bootstrapLedger.processGroups,
      abortController.signal,
    );
    head = candidate.head;
    tree = candidate.tree;
    const externalRunId =
      process.env["TANREN_SMOKE_RUN_ID"] ?? `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
    const runtimeBase =
      process.env["TANREN_SMOKE_RUNTIME_BASE"] ?? join(process.env["HOME"] ?? tmpdir(), ".config", "tanren", "runtime");
    receiptPath =
      process.env["TANREN_SMOKE_RECEIPT_PATH"] ??
      join(runtimeBase, "smoke-receipts", `${candidate.head.slice(0, 12)}-${nonce}.json`);
    let context = createStackContext({
      root: candidate.root,
      head: candidate.head,
      tree: candidate.tree,
      runId: externalRunId,
      nonce,
      runtimeBase,
      receiptPath,
      ports: findAvailablePorts(process.env, externalRunId),
    });
    const validated = await paths.validateSmokePaths({
      checkoutRoot: context.root,
      runtimeBase,
      runtimeDir: context.runtimeDir,
      receiptPath,
    });
    receiptPath = validated.receiptPath;
    context = { ...context, root: validated.checkoutRoot, executionRoot: validated.checkoutRoot, receiptPath };
    await paths.assertArtifactPathSafe(receiptPath, [context.runtimeDir], context.root);
    if (candidate.porcelain !== "")
      throw new Error(`smoke requires a clean committed worktree:\n${candidate.porcelain}`);
    const checkoutFingerprint = await build.fingerprintTree(context.root);
    const buildSource = await build.createCleanBuildContext(
      context.root,
      context.head,
      context.tree,
      candidate.env,
      bootstrapLedger,
      (base) => {
        buildBase = base;
      },
    );
    if (buildBase === undefined) throw new Error("archive builder did not expose its owned root");
    await paths.assertArtifactPathSafe(receiptPath, [context.runtimeDir, buildBase], context.root);
    const finalCandidate = await lifecycle.readCandidateIdentity(
      context.root,
      candidate.env,
      bootstrapLedger.processGroups,
      abortController.signal,
    );
    if (
      finalCandidate.head !== context.head ||
      finalCandidate.tree !== context.tree ||
      finalCandidate.porcelain !== "" ||
      (await build.fingerprintTree(context.root)) !== checkoutFingerprint
    ) {
      throw new Error("candidate checkout changed while preparing the verified execution archive");
    }
    const executionFingerprint = await build.fingerprintTree(buildSource);
    bootstrapLedger.processGroups.assertEmpty();
    context = withExecutionRoot(context, buildSource);
    const coordinatorUrl = pathToFileURL(join(buildSource, "scripts", "smoke", "run-stack.ts")).href;
    const coordinator = (await import(coordinatorUrl)) as {
      runPreparedSmoke(prepared: PreparedSmokeRun): Promise<number>;
    };
    return await coordinator.runPreparedSmoke({
      startedAt,
      runtimeBase: validated.runtimeBase,
      context,
      candidate,
      buildBase,
      buildSource,
      checkoutFingerprint,
      executionFingerprint,
      fallbackReceiptPath,
      abortController,
      signalState,
      ambient: process.env,
    });
  } catch (error) {
    if (bootstrapLedger !== undefined) {
      try {
        await bootstrapLedger.processGroups.fenceAll();
      } catch (cleanupError) {
        cleanupErrors.push(`process cleanup: ${sanitizedError(cleanupError)}`);
      }
    }
    if (buildBase !== undefined) {
      try {
        const { removeBuildBase } = await import("./stack-build.js");
        await removeBuildBase(buildBase);
      } catch (cleanupError) {
        cleanupErrors.push(`archive cleanup: ${sanitizedError(cleanupError)}`);
      }
    }
    await publishBootstrapFailure({ error, receiptPath, nonce, head, tree, cleanupErrors });
    process.stderr.write(`${sanitizedError(error)}\n`);
    return signalState.exitCode ?? 1;
  }
}

try {
  process.exitCode = await bootstrap();
} finally {
  process.off("SIGINT", onSigInt);
  process.off("SIGTERM", onSigTerm);
}
