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
 * REAPER-SAFETY (`TANREN_MAX_RUN_HOURS`): this knob is integrated via the
 * `requirePositiveHours` helper. UNSET → the documented 6h default; a PRESENT
 * non-positive / malformed run-hour cap THROWS loud at boot (no-silent-fallback
 * doctrine, Codex r4 §1) — because a `<= now` reaper threshold would reap EVERY
 * active runner (incl. a live apex run), so a typo'd operator value must fail the
 * boot rather than masquerade as a working default. The helper is reused here so
 * the same UNSET-defaults / PRESENT-malformed-throws contract governs both the
 * allocator schema AND the scoped-token TTL resolver (plannerRunScopedCreds).
 */
import { z } from "zod";
import { requirePositiveHours } from "./requirePositiveHours.js";

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
  // Max wall-clock hours before the abandoned-run sweeper reclaims a runner.
  // Resolved through `requirePositiveHours` (reaper-safety: fall back loud, never
  // crash, never accept <= 0). Carried through the schema as the raw string and
  // transformed to the safe positive number; default applied by the helper.
  TANREN_MAX_RUN_HOURS: z
    .string()
    .optional()
    .transform((raw) => requirePositiveHours(raw, 6, "TANREN_MAX_RUN_HOURS")),
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
