// ds-7 — DB-free static check + negative-control helpers extracted from
// `frameworkAdapterCore.ts` to keep that file under the 500-line cap. These are
// the fail-closed arms the conformance receipt's negative controls exercise,
// pure functions over design-VFS descriptors so they unit-test without Postgres.

import type { DesignAdapterCheckResult, DesignVfsView } from "./designTargetAdapter.js";
import type { DesignArtifactFileV1 } from "./designArtifactSchemas.js";
import { DesignVfs } from "./designVfs.js";

/**
 * Run a target's static check over a descriptor-only VFS view. DB-free so the
 * fail-closed decision table is unit-tested without Postgres (RLS-gated tests
 * don't count toward CI statement coverage, so the arms need this surface).
 */
export function staticCheck(
  target: string,
  expected: readonly DesignArtifactFileV1[],
  vfs: DesignVfsView,
): DesignAdapterCheckResult {
  const expectedMap = new Map(expected.map((descriptor) => [descriptor.path, descriptor]));
  const actual = new Map(vfs.files.map((file) => [file.path, file]));
  const findings = [...expectedMap.entries()].flatMap(([path, descriptor]) => {
    const actualDescriptor = actual.get(path);
    if (actualDescriptor === undefined) {
      return [
        {
          code: `${target}.artifact_file_missing`,
          severity: "p0" as const,
          message: `missing '${path}'`,
          path,
        },
      ];
    }
    if (actualDescriptor.digest !== descriptor.digest || actualDescriptor.byteSize !== descriptor.byteSize) {
      return [
        {
          code: `${target}.artifact_file_digest_mismatch`,
          severity: "p0" as const,
          message: `mismatched '${path}'`,
          path,
        },
      ];
    }
    return [];
  });
  return { ok: findings.length === 0, checkKey: `${target}.static.v1`, findings };
}

/**
 * Build an INJECTED broken VFS for a negative control: drop a file
 * (`.artifact_file_missing` case) or alter its digest
 * (`.artifact_file_digest_mismatch` case). The receipt's `passed` flag is then
 * set ONLY when the validator reports the expected finding code — proving the
 * gate catches the regression.
 */
export function injectBrokenVfs(
  descriptors: readonly DesignArtifactFileV1[],
  brokenPath: string,
  expectFindingCode: string,
): DesignVfsView {
  if (expectFindingCode.endsWith(".artifact_file_missing")) {
    return new DesignVfs(descriptors.filter((descriptor) => descriptor.path !== brokenPath));
  }
  // Digest drift: replace the descriptor at brokenPath with a tampered digest.
  const tampered = descriptors.map((descriptor) =>
    descriptor.path === brokenPath
      ? { ...descriptor, digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }
      : descriptor,
  );
  return new DesignVfs(tampered);
}
