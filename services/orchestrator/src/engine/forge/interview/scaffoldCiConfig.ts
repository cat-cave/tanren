// The CONCRETE correct-shape `.tanren/ci.yml` the greenfield scaffold writer is
// instructed to author, embedded VERBATIM in the `monorepo scaffold` description
// (derive.ts). It is the SINGLE SOURCE so the prose example can't drift from a
// shape that actually parses: the round-trip test parses THIS string through
// `resolveCiConfig` (the real CiConfigV1 schema) and asserts the 3-tier `when`
// mapping.
//
// The shape is the v25 fix. v25 emitted the WRONG shape — each tier as an OBJECT
// with an inline `when`, and no top-level `when` — which fails CiConfigV1
// validation (`tiers.fast: expected array, received object; when: expected
// record, received undefined`) and crash-looped the worker. The CORRECT shape:
// `tiers` is a MAP of tierName → an ARRAY of `{ name, run }` steps, and `when` is
// a SEPARATE top-level MAP of tierName → an array of lifecycle points.
//
// BLOCK STYLE is mandatory: Tanren's gate parser (engine/ci/yaml.ts) is a minimal
// subset parser that does NOT accept flow collections (`[per_iteration]` /
// `{ name: …, run: … }`) — those parse as bare scalars and fail the schema. The
// example below is block-style throughout.

import { JUNIT_REPORT_PATH } from "../../ci/index.js";

export const SCAFFOLD_CI_CONFIG_EXAMPLE = `version: 1
bootstrap:
  run: pnpm install --frozen-lockfile
tiers:
  fast:
    - name: lint
      run: pnpm lint
    - name: typecheck
      run: pnpm typecheck
  slow:
    - name: build
      run: pnpm build
    - name: test
      run: pnpm test -- --reporter=junit --outputFile=${JUNIT_REPORT_PATH}
  merge:
    - name: lint
      run: pnpm lint
    - name: typecheck
      run: pnpm typecheck
    - name: build
      run: pnpm build
    - name: test
      run: pnpm test -- --reporter=junit --outputFile=${JUNIT_REPORT_PATH}
when:
  fast:
    - per_iteration
  slow:
    - pre_audit
  merge:
    - pre_merge
`;
