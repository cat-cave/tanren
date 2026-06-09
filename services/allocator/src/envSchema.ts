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
 * REAPER-SAFETY EXCEPTION (`TANREN_MAX_RUN_HOURS`): this knob is integrated via
 * the merged `requirePositiveHours` helper, NOT a crash-on-bad Zod field. A
 * non-positive / malformed run-hour cap must NOT crash the allocator — it falls
 * back to the default with a LOUD `console.error` — because a `<= now` reaper
 * threshold would reap EVERY active runner (incl. a live apex run). So the helper
 * is reused here, unchanged, to resolve this one field while the rest of the
 * schema validates strictly.
 */
import { z } from "zod";
import { requirePositiveHours } from "./requirePositiveHours.js";

/** A TCP port: coerced from the env string, finite integer, 1–65535. */
const portSchema = z.coerce.number().int().finite().min(1).max(65_535);

/** A positive millisecond interval. */
const positiveIntervalMsSchema = z.coerce.number().int().finite().positive();

const envObjectSchema = z.object({
  // Allocator API HTTP port. Default 3200.
  ALLOCATOR_PORT: portSchema.default(3200),
  // Max wall-clock hours before the abandoned-run sweeper reclaims a runner.
  // Resolved through `requirePositiveHours` (reaper-safety: fall back loud, never
  // crash, never accept <= 0). Carried through the schema as the raw string and
  // transformed to the safe positive number; default applied by the helper.
  TANREN_MAX_RUN_HOURS: z
    .string()
    .optional()
    .transform((raw) => requirePositiveHours(raw, 6, "TANREN_MAX_RUN_HOURS")),
  // Docker network the per-run runner containers join.
  TANREN_ALLOCATOR_NETWORK: z.string().min(1).default("tanren_default"),
  // Optional host SSH port to publish a runner on (dev/local). When unset the
  // runner is reachable only on the internal docker network. A port when present.
  TANREN_ALLOCATOR_HOST_SSH_PORT: portSchema.optional(),
  // Template the orchestrator-facing SSH hostname is built from ({container}).
  TANREN_ALLOCATOR_SSH_HOSTNAME_TEMPLATE: z.string().min(1).default("{container}"),
  // Abandoned-run sweep interval. Default 60_000ms.
  TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS: positiveIntervalMsSchema.default(60_000),
  // Linux capabilities / security-opt the per-run runner container is launched
  // with (comma-separated). Empty parts are filtered downstream.
  TANREN_RUNNER_CAP_ADD: z.string().default("SYS_ADMIN"),
  TANREN_RUNNER_SECURITY_OPT: z.string().default("apparmor=unconfined,seccomp=unconfined"),
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
