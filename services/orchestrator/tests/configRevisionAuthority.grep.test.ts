// Architecture grep: the sole config-write authority is application
// config_revision CAS. Production must not retain LWW updateConfig, direct
// UPDATE … SET config on projects/organizations, or xmin-as-config-token.
// Queue-recovery xmin effect probes in merge tests are out of scope.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTs(full));
      continue;
    }
    if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("config revision sole-authority architecture", () => {
  const files = walkTs(SRC);

  it("deletes ProjectStore.updateConfig and production LWW config SQL", () => {
    const storeFiles = new Set(["src/engine/repositories/projects.ts", "src/engine/repositories/organizations.ts"]);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const rel = relative(ROOT, file);
      if (/\.updateConfig\s*\(/u.test(text) || /ProjectStore\.updateConfig/u.test(text)) {
        offenders.push(`${rel}: updateConfig`);
      }
      // LWW shape: SET config without the sole CAS revision increment.
      // Store CAS is allowed to SET config only alongside config_revision + 1.
      const hasLww =
        /UPDATE\s+(projects|organizations)\s+SET\s+config\s*=/iu.test(text) &&
        !/config_revision\s*=\s*config_revision\s*\+\s*1/u.test(text);
      if (hasLww) {
        offenders.push(`${rel}: LWW UPDATE SET config`);
      }
      // Route-local or non-store CAS SQL is also banned (increment lives only in stores).
      if (!storeFiles.has(rel) && /config_revision\s*=\s*config_revision\s*\+\s*1/u.test(text)) {
        offenders.push(`${rel}: config CAS SQL outside repository layer`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not use xmin as a production config revision token", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const rel = relative(ROOT, file);
      // Production config CAS must never surface xmin as revision.
      if (/xmin\s*::\s*text\s+AS\s+revision/iu.test(text)) {
        offenders.push(`${rel}: xmin::text AS revision`);
      }
      if (
        /config.*xmin|xmin.*config_revision/iu.test(text) &&
        /revision/iu.test(text) &&
        /expectedRevision|compareAndSwap|getConfigSnapshot/u.test(text)
      ) {
        offenders.push(`${rel}: xmin near config CAS`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("centralizes project/org config CAS SQL in the repository layer", () => {
    const storeFiles = new Set(["src/engine/repositories/projects.ts", "src/engine/repositories/organizations.ts"]);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (storeFiles.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (/config_revision\s*=\s*config_revision\s*\+\s*1/u.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("routes accept revision only via shared ConfigRevisionSchema (no local digit regex)", () => {
    const allowed = new Set(["src/engine/config/configRevision.ts"]);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (allowed.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      // Ban wire-local revision digit regexes; must import ConfigRevisionSchema.
      if (/revision\s*:\s*z\.string\(\)\s*\.regex\(\s*\/\^\[1-9\]\\d\*\$\//u.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
