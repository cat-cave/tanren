/**
 * envSchema — the allocator's SINGLE boot-time environment contract.
 *
 * Doctrine (no-silent-fallback + three-layer config): the allocator's numeric /
 * string platform knobs are validated HERE, once, at module load, via Zod. A
 * malformed value (a non-numeric / out-of-range port, a non-positive sweeper
 * interval) FAILS LOUD at boot — `main.ts` reads `parsedEnv.X` instead of
 * `Number(process.env[...] ?? n)`.
 *
 * This is the ONLY allocator boot module that reads these `TANREN_*` / port env
 * vars directly (enforced by scripts/lint/env-read-whitelist.mjs). The REQUIRED
 * secrets that must fail loud when MISSING — `TANREN_ALLOCATOR_TOKEN`,
 * `MIGRATION_DATABASE_URL` — keep their `requireEnv` guards (resolved at use, so a
 * unit test can import the schema without the production secret env).
 *
 * NO WALL-CLOCK REAP KNOB: the abandoned-runner sweeper reaps on SIGN-OF-LIFE
 * (the owning run's job lease lapsing — a dead driver), never on a wall-clock age
 * ceiling, so there is no `TANREN_MAX_RUN_HOURS` here. A long-but-alive build is
 * never reaped. (`TANREN_MAX_RUN_HOURS` still exists as the orchestrator's
 * scoped-credential token TTL — a separate security bound — resolved in
 * plannerRunScopedCreds, not the allocator.)
 */
import { z } from "zod";

/**
 * Treat an EMPTY env string as UNSET (`undefined`) before validation — see the
 * orchestrator schema for the rationale: Tanren's compose passes optional host
 * env via `${VAR:-}`, which materializes an unset var as `""` (not an absent
 * key) inside the container. Coercing `""` → `undefined` lets defaults/optional
 * apply for an unset-in-dev var while a genuinely-malformed present value still
 * fails loud.
 */
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema);

/** A TCP port: coerced from the env string, finite integer, 1–65535. */
const portSchema = z.coerce.number().int().finite().min(1).max(65_535);

/** A positive millisecond interval. */
const positiveIntervalMsSchema = z.coerce.number().int().finite().positive();

// Every field wraps `emptyToUndefined` AS THE OUTERMOST modifier — the `""`→unset
// coercion runs before the `.optional()`/`.default()` decision (so an `""` from
// compose's `${VAR:-}` applies the default / stays optional, never crashes boot).
const envObjectSchema = z.object({
  // Allocator API HTTP port. Default 3200.
  ALLOCATOR_PORT: emptyToUndefined(portSchema.default(3200)),
  // Docker network the per-run runner containers join.
  TANREN_ALLOCATOR_NETWORK: emptyToUndefined(z.string().min(1).default("tanren_default")),
  // Optional host SSH port to publish a runner on (dev/local). When unset the
  // runner is reachable only on the internal docker network. A port when present.
  TANREN_ALLOCATOR_HOST_SSH_PORT: emptyToUndefined(portSchema.optional()),
  // Template the orchestrator-facing SSH hostname is built from ({container}).
  TANREN_ALLOCATOR_SSH_HOSTNAME_TEMPLATE: emptyToUndefined(z.string().min(1).default("{container}")),
  // Runner-sweep interval. Default 60_000ms.
  TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS: emptyToUndefined(positiveIntervalMsSchema.default(60_000)),
  // Grace window before a run-LESS (never-claimed) allocation is reclaimed by the
  // sweeper as a WEDGED allocation. A short grace (default 15min) absorbs the normal
  // allocate→claim handoff so a freshly-allocated run-less runner is never reaped
  // mid-handshake; past it, an allocation never tied to a live run is genuinely stuck.
  TANREN_ALLOCATOR_UNCLAIMED_GRACE_MS: emptyToUndefined(positiveIntervalMsSchema.default(900_000)),
  // Linux capabilities / security-opt the per-run runner container is launched
  // with (comma-separated). Empty parts are filtered downstream.
  TANREN_RUNNER_CAP_ADD: emptyToUndefined(z.string().default("SYS_ADMIN")),
  TANREN_RUNNER_SECURITY_OPT: emptyToUndefined(z.string().default("apparmor=unconfined,seccomp=unconfined")),
});

export type AllocatorEnv = z.infer<typeof envObjectSchema>;

/** Parse `source` (defaults to process.env), throwing a LOUD aggregate on failure. */
export function parseAllocatorEnv(source: NodeJS.ProcessEnv = process.env): AllocatorEnv {
  const result = envObjectSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid allocator environment (fail-closed at boot):\n${issues}`);
  }
  return result.data;
}

/**
 * The validated env, parsed ONCE at module load. Importing this module asserts the
 * env is well-formed; a malformed value crashes the boot here, by design.
 */
export const parsedEnv: AllocatorEnv = parseAllocatorEnv();
