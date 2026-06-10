// Typed, loud-fail errors the non-`direct_api` deploy adapter classes (pulumi /
// package_release / mobile_release / manual_external) throw when a REQUIRED external
// credential / target / config is absent. The one-way-right-way posture: a real
// implementation that cannot reach its external target FAILS LOUD with an actionable
// typed error — it NEVER no-ops or stands in. These carry only NON-SECRET context
// (the adapter kind + the missing config key + an operator-actionable hint), never a
// token or a secret value.

/**
 * A required adapter config / credential / target is absent (e.g. a Pulumi backend
 * URL, a registry the package publishes to, a mobile distribution channel, the
 * operator-declared external URL). Thrown LOUD at the use-site instead of degrading
 * to a default — the correct "unconfigured" behavior, not a stub. `kind` is the
 * adapter class; `missing` is the config key the operator must set; `hint` is the
 * actionable remediation.
 */
export class DeployAdapterConfigError extends Error {
  constructor(
    readonly kind: string,
    readonly missing: string,
    readonly hint: string,
  ) {
    super(`deploy adapter '${kind}': required config '${missing}' is not set — ${hint}`);
    this.name = "DeployAdapterConfigError";
  }
}

/**
 * The provider-side operation reached a FAILURE terminal (a Pulumi `up` that errored,
 * a registry publish the registry rejected, a mobile submission the channel refused,
 * an operator-declared URL that does not answer). Thrown LOUD so a configured deploy
 * that genuinely failed surfaces — never an assumed-success. Carries the adapter
 * kind + a non-secret detail string.
 */
export class DeployAdapterOperationError extends Error {
  constructor(
    readonly kind: string,
    detail: string,
  ) {
    super(`deploy adapter '${kind}': ${detail}`);
    this.name = "DeployAdapterOperationError";
  }
}
