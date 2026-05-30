const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // SecretStore seam + backends cluster. Disjoint from the run-loop (#107),
  // allocator (#147), workflow-stage (#149), forge (#152), and notifications
  // (#157) clusters: this covers the SecretStore contract + in-memory/Vault
  // impls (secretStore.ts), the ref->key mappers and the GCP Secret Manager,
  // AWS Secrets Manager, and 1Password Connect backends, plus the
  // TANREN_SECRET_STORE-driven factory (secretStoreFactory.ts).
  mutate: [
    "services/orchestrator/src/engine/contracts/secretStore.ts",
    "services/orchestrator/src/engine/contracts/secretStoreFactory.ts",
    "services/orchestrator/src/engine/contracts/gcpSecretManager.ts",
    "services/orchestrator/src/engine/contracts/awsSecretsManager.ts",
    "services/orchestrator/src/engine/contracts/onePassword.ts",
  ],
  reporters: ["clear-text"],
  // Ratcheted floor (test/mutation-ratchet-secret-stores). The SecretStore seam
  // + backends cluster was strengthened from 55.16% to 95.96% (secretStore.ts
  // 75.44->100, secretStoreFactory 51.72->98.85, gcpSecretManager 66.22->97.30,
  // awsSecretsManager 45.11->93.98, onePassword 51.58->92.63). Tests drive each
  // backend through a recording/stub transport and assert the exact wire shape
  // (URL/method/headers, x-amz-target + full SigV4 signature for AWS, base64
  // payload for GCP, create-vs-PUT + CONCEALED field for 1Password, KV v2 mount
  // path for Vault), the ref->key mapping, put/get/delete + not-found/error
  // mapping, and the TANREN_SECRET_STORE-driven factory selection + env config
  // resolution. `break` sits just below the measured score so this run passes
  // today and a regression below the floor fails. The ~17 remaining survivors
  // are genuine equivalents: the crypto `"utf8"`->`""` encoding mutants (Node
  // defaults to utf8, so ASCII secrets/signatures are byte-identical), the
  // cosmetic empty-string `assertOk`/`assertVaultOk` messages on success paths
  // that never error, the `filter(h => h !== "authorization")` no-op (the
  // authorization header is appended AFTER the signed set is built), the
  // `{ ...item, id: undefined }` JSON-drop on the create branch, the empty-list
  // `items[0]?.id` optional-chaining (undefined either way), and the
  // `optional()` undefined-equivalent branch. See the PR body.
  thresholds: { high: 80, low: 60, break: 95 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-secrets",
  concurrency: 4,
  timeoutMS: 60000,
};
export default config;
