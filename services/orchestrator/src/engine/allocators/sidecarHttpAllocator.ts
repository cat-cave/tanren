import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type AllocatorTaxonomy,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

/**
 * Resolve the sidecar bearer token, FILE-PREFERRED (Codex r5): prod mounts it as
 * `/run/secrets/tanren_allocator_token` and sets `TANREN_ALLOCATOR_TOKEN_FILE`, so the
 * token VALUE never lands in Docker env / `docker inspect`; dev sets the plaintext
 * `TANREN_ALLOCATOR_TOKEN`. The file WINS; a configured-but-empty/unreadable file is a
 * HARD failure (never a silent blank token), as is a missing token altogether. Lives
 * here (not buildAllocator) so the orchestrator-side allocator factory does not take a
 * new fs dependency. Reads `process.env` (injectable for tests).
 */
export function resolveSidecarAuthToken(env: Record<string, string | undefined> = process.env): string {
  const filePath = env["TANREN_ALLOCATOR_TOKEN_FILE"];
  if (filePath !== undefined && filePath !== "") {
    let contents: string;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch (cause) {
      throw new Error(`TANREN_ALLOCATOR_TOKEN_FILE=${filePath} could not be read`, { cause });
    }
    const value = contents.trim();
    if (value === "") {
      throw new Error(
        `TANREN_ALLOCATOR_TOKEN_FILE=${filePath} is empty (no allocator bearer token in the mounted file)`,
      );
    }
    return value;
  }
  const envValue = env["TANREN_ALLOCATOR_TOKEN"];
  if (envValue === undefined || envValue === "") {
    throw new Error("TANREN_ALLOCATOR_TOKEN is required (set it in the environment; there is no default)");
  }
  return envValue;
}

export interface SidecarHttpAllocatorOptions {
  /** Base URL of the allocator sidecar, e.g. `http://allocator:3200`. */
  baseUrl: string;
  /** Bearer token shared with the allocator sidecar. */
  authToken: string;
  /** Username the SSH substrate authenticates with. */
  sshUsername?: string;
  /** Stores release bookkeeping for the sidecar-owned runners row. */
  runners: RunnerStore;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

// Audit C2 §9: parse-on-receive schemas for the sidecar HTTP boundary. The old
// `as SidecarAllocateResponse` / `as SidecarReleaseResponse` casts trusted any
// 2xx body — a malformed reply propagated `undefined` fields into the returned
// `RunnerAllocation` (a live host but no valid `target`, silent bad-shape sshHost
// → run configuration) or dropped `released` falsy so the mirror row stayed
// "allocated" forever (a runner leak). Failing loud at the wire boundary makes
// the fault an infra error the caller can back off + retry instead of a silent
// leak / silently-broken allocation.
const sidecarAllocateResponseSchema = z.object({
  runnerId: z.string().min(1),
  sshHost: z.string().min(1),
  sshPort: z.number().int().min(1).max(65_535),
  hostKeyFingerprint: z.string().min(1),
  imageSha: z.string().min(1),
});
type SidecarAllocateResponse = z.infer<typeof sidecarAllocateResponseSchema>;

const sidecarReleaseResponseSchema = z.object({
  released: z.boolean(),
});
type SidecarReleaseResponse = z.infer<typeof sidecarReleaseResponseSchema>;

/**
 * Thrown when the sidecar `/allocate` reply body drifts from the wire schema.
 * The old unchecked `as SidecarAllocateResponse` cast let this failure surface
 * downstream as an SSH connection to `undefined` — this error routes it out at
 * the boundary with the Zod issues + a redacted view of the offending payload.
 */
export class SidecarAllocateTransportError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];
  readonly payloadPreview: string;

  constructor(issues: readonly z.core.$ZodIssue[], rawPayload: unknown) {
    const preview = redactedPayloadPreview(rawPayload);
    const summary = issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    super(
      `allocator sidecar /allocate returned a body that did not match the wire schema: ${summary} — payload preview: ${preview}`,
    );
    this.name = "SidecarAllocateTransportError";
    this.issues = issues;
    this.payloadPreview = preview;
  }
}

/**
 * Thrown when the sidecar `/release` reply body drifts from the wire schema.
 * The old unchecked `as SidecarReleaseResponse` cast let a malformed 200 drop
 * `released` falsy → the mirror `runners` row was never cleared → the runner
 * "leaked" as allocated forever. This error makes that fault loud.
 */
export class SidecarReleaseTransportError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];
  readonly payloadPreview: string;

  constructor(issues: readonly z.core.$ZodIssue[], rawPayload: unknown) {
    const preview = redactedPayloadPreview(rawPayload);
    const summary = issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    super(
      `allocator sidecar /release returned a body that did not match the wire schema: ${summary} — payload preview: ${preview}`,
    );
    this.name = "SidecarReleaseTransportError";
    this.issues = issues;
    this.payloadPreview = preview;
  }
}

/**
 * Redact a value for inclusion in an error message: show the shape (top-level
 * keys + value TYPES) but NEVER the values. Keeps the error diagnosable without
 * leaking response content into logs.
 */
function redactedPayloadPreview(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return `<${typeof value}>`;
  if (Array.isArray(value)) return `<array[${value.length}]>`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 20);
  const parts = keys.map((key) => {
    const inner = record[key];
    const type = inner === null ? "null" : Array.isArray(inner) ? "array" : typeof inner;
    return `${JSON.stringify(key)}:<${type}>`;
  });
  return `{${parts.join(",")}}`;
}

/**
 * Orchestrator-side allocator client. The orchestrator container no longer has
 * Docker socket access; instead it calls the allocator sidecar over
 * HTTP. The sidecar owns container lifecycle and finalizer cleanup.
 */
export class SidecarHttpAllocator implements Allocator {
  // DELEGATED: the orchestrator does not create or destroy runner containers
  // itself; the sidecar service owns full container lifecycle over an HTTP
  // seam. From the orchestrator's perspective release DOES tear the runner
  // down (the sidecar destroys), but the credentials + docker-socket access
  // + finalizer wipes live in the sidecar service — not here.
  readonly taxonomy: AllocatorTaxonomy = "delegated";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SidecarHttpAllocatorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    // SYSTEM-vs-USERLAND credential split: NO secret ref or VALUE is ever sent to
    // the sidecar. The allocator only creates/destroys containers + persists the
    // `runners` row; it has no secret-store access and delivers no secret to a
    // runner via Docker env. `identitySecretRef` (the orchestrator's own SSH
    // private key, how Tanren reaches the runner) belongs ONLY in the returned
    // `target` handle, which the orchestrator's SSH substrate resolves to open the
    // connection. Run-scoped runner creds (the tenant's model/codex auth) are
    // delivered over the SSH FILE substrate AFTER allocation (codexMaterializer /
    // opencodeMaterializer).
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, "")}/allocate`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        // runId/projectId are the runner's naming HANDLE (container + volume
        // names). For a runless Forge ideation allocation the service persists its
        // runners row's run_id as NULL and project_id as `persistedProjectId`
        // (NULL or the real project) — it keys off `runless`, not off these being
        // absent, so naming stays stable while the FK columns stay FK-safe.
        runId: request.runId,
        projectId: request.projectId,
        runnerImage: request.runnerImage,
        orgId: request.orgId,
        ...(request.runless === true
          ? { runless: true, persistedProjectId: persistedRunnerKeys(request).projectId }
          : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`allocator sidecar /allocate failed: ${response.status} ${await response.text()}`);
    }
    // Audit C2 §9: parse-on-receive at the HTTP boundary. Previously the reply
    // was trusted as `SidecarAllocateResponse` unconditionally — a malformed 2xx
    // silently propagated `undefined` sshHost into the returned target handle.
    const rawBody: unknown = await response.json();
    const parsed = sidecarAllocateResponseSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new SidecarAllocateTransportError(parsed.error.issues, rawBody);
    }
    const body: SidecarAllocateResponse = parsed.data;
    const allocation: RunnerAllocation = {
      runnerId: body.runnerId,
      imageSha: body.imageSha,
      target: sshRunnerHandle({
        host: body.sshHost,
        port: body.sshPort,
        username: this.options.sshUsername ?? "tanren",
        hostKeyFingerprint: body.hostKeyFingerprint,
        identitySecretRef: request.identitySecretRef,
      }),
    };

    return allocation;
  }

  async release(runnerId: string, reason: ReleaseReason = "completed"): Promise<void> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, "")}/release`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ runnerId, reason }),
    });
    if (!response.ok) {
      throw new Error(`allocator sidecar /release failed: ${response.status} ${await response.text()}`);
    }
    // Audit C2 §9: parse-on-receive at the HTTP boundary. Previously the reply
    // was cast as `SidecarReleaseResponse` — a malformed 2xx dropped `released`
    // truthiness so the mirror `runners` row was never cleared, leaving the
    // runner "allocated" forever in the DB (a leak). Failing loud here forces
    // the caller to see the wire fault instead of silently missing the release.
    const rawBody: unknown = await response.json();
    const parsed = sidecarReleaseResponseSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new SidecarReleaseTransportError(parsed.error.issues, rawBody);
    }
    const body: SidecarReleaseResponse = parsed.data;
    if (body.released) {
      await this.options.runners.release(runnerId);
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      authorization: `Bearer ${this.options.authToken}`,
    };
  }
}
