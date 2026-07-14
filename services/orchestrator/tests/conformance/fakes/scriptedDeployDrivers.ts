// Scripted in-memory drivers for the non-`direct_api` DeployAdapter classes (TEST
// FIXTURE — tests/ only): a Pulumi stack runner, a package registry client, and a
// mobile distribution client. Each emulates just enough of its provider surface for
// the conformance suite to drive the FULL adapter lifecycle (provision → deploy →
// poll-to-ready) with NO real Pulumi/registry/channel process. Each records the
// bearer tokens it saw so a test can prove the token VALUE is used but never echoed,
// and lets a test SCRIPT the status sequence the verify poll walks.

import type {
  PulumiStackRunner,
  PulumiUpdateResult,
  PulumiUpdateStatus,
} from "../../../src/engine/deploy/pulumiDeployAdapter.js";
import type {
  PackageRegistryClient,
  PackagePublishResult,
  PackageVersionStatus,
} from "../../../src/engine/deploy/packageReleaseDeployAdapter.js";
import type {
  MobileDistributionClient,
  MobileSubmissionResult,
  MobileSubmissionStatus,
} from "../../../src/engine/deploy/mobileReleaseDeployAdapter.js";

const SCRIPTED_ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;
const SCRIPTED_PROVIDER_CHECKSUM = `sha512:${"b".repeat(128)}`;

export interface ScriptedPulumiRunner extends PulumiStackRunner {
  bearersSeen: string[];
  /** Script the update-result sequence the runner reports on successive `updateStatus` polls. */
  scriptUpdateResults(updateId: string, results: string[]): void;
  /** How many `updateStatus` polls were served for an update id. */
  statusPolls(updateId: string): number;
}

/**
 * A scripted Pulumi runner: `ensureStack` is idempotent (returns the qualified id),
 * `up` returns a fixed update id + endpoint, `updateStatus` walks the scripted result
 * sequence (the last entry repeats; default "succeeded"). The endpoint URL is published
 * once the update reaches "succeeded".
 */
export function scriptedPulumiRunner(endpoint = "https://acme-web.example.dev"): ScriptedPulumiRunner {
  const bearersSeen: string[] = [];
  const scripts = new Map<string, string[]>();
  const polls = new Map<string, number>();
  let counter = 0;
  return {
    bearersSeen,
    scriptUpdateResults: (updateId, results) => {
      scripts.set(updateId, [...results]);
    },
    statusPolls: (updateId) => polls.get(updateId) ?? 0,
    async ensureStack(input): Promise<{ stackId: string }> {
      bearersSeen.push(input.token);
      return { stackId: `${input.project}/${input.stack}` };
    },
    async up(input): Promise<PulumiUpdateResult> {
      bearersSeen.push(input.token);
      counter += 1;
      return { updateId: `update_${counter}`, endpointUrl: endpoint };
    },
    async resolveArtifactIdentity(input) {
      bearersSeen.push(input.token);
      return { artifactDigest: SCRIPTED_ARTIFACT_DIGEST, providerChecksum: null };
    },
    async previewUp(input) {
      bearersSeen.push(input.token);
      counter += 1;
      return { previewId: `preview_${counter}`, updateId: `update_${counter}`, endpointUrl: endpoint };
    },
    async promote(input): Promise<PulumiUpdateResult> {
      bearersSeen.push(input.token);
      counter += 1;
      return { updateId: `promote_${counter}`, endpointUrl: endpoint };
    },
    async rollback(input): Promise<PulumiUpdateResult> {
      bearersSeen.push(input.token);
      counter += 1;
      return { updateId: `rollback_${counter}`, endpointUrl: endpoint };
    },
    async teardownStack(input): Promise<void> {
      bearersSeen.push(input.token);
    },
    async updateStatus(input): Promise<PulumiUpdateStatus> {
      bearersSeen.push(input.token);
      const served = polls.get(input.updateId) ?? 0;
      polls.set(input.updateId, served + 1);
      const script = scripts.get(input.updateId) ?? ["succeeded"];
      const result = script[Math.min(served, script.length - 1)] as string;
      const succeeded = result === "succeeded";
      const failed = result === "failed" || result === "canceled";
      return { result, succeeded, failed, endpointUrl: succeeded ? endpoint : "" };
    },
  };
}

export interface ScriptedPackageRegistry extends PackageRegistryClient {
  bearersSeen: string[];
  /** Script the resolvable sequence the registry reports on successive `versionStatus` polls. */
  scriptResolvable(version: string, resolvable: boolean[]): void;
  statusPolls(version: string): number;
}

/** The installable coordinate for a published version (`<packageName>@<version>`). */
function packageCoordinate(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

/** A deterministic version derived from the merged ref's short sha. */
function packageVersionFor(ref: string): string {
  return `0.0.0-${ref.slice(0, 7)}`;
}

/**
 * A scripted package registry: `publish` returns `<packageName>@<derived-version>`,
 * `versionStatus` walks the scripted resolvable sequence (last entry repeats; default
 * resolvable). The version derives from the merged ref's short sha for determinism.
 */
export function scriptedPackageRegistry(): ScriptedPackageRegistry {
  const bearersSeen: string[] = [];
  const scripts = new Map<string, boolean[]>();
  const polls = new Map<string, number>();
  return {
    bearersSeen,
    scriptResolvable: (version, resolvable) => {
      scripts.set(version, [...resolvable]);
    },
    statusPolls: (version) => polls.get(version) ?? 0,
    async publish(input): Promise<PackagePublishResult> {
      bearersSeen.push(input.token);
      const version = packageVersionFor(input.source.ref);
      return { version, coordinate: packageCoordinate(input.packageName, version) };
    },
    async versionStatus(input): Promise<PackageVersionStatus> {
      bearersSeen.push(input.token);
      const served = polls.get(input.version) ?? 0;
      polls.set(input.version, served + 1);
      const script = scripts.get(input.version) ?? [true];
      const resolvable = script[Math.min(served, script.length - 1)] as boolean;
      return { resolvable, coordinate: resolvable ? packageCoordinate(input.packageName, input.version) : "" };
    },
    async resolveArtifactIdentity(input) {
      bearersSeen.push(input.token);
      return {
        artifactDigest: SCRIPTED_ARTIFACT_DIGEST,
        providerChecksum: SCRIPTED_PROVIDER_CHECKSUM,
      };
    },
  };
}

export interface ScriptedMobileDistribution extends MobileDistributionClient {
  bearersSeen: string[];
  /** Script the state sequence the channel reports on successive `submissionStatus` polls. */
  scriptStates(buildRef: string, states: string[]): void;
  statusPolls(buildRef: string): number;
}

/**
 * A scripted mobile distribution channel: `submit` returns a fixed build ref,
 * `submissionStatus` walks the scripted state sequence (last entry repeats; default
 * "available"). "available" → available terminal; "rejected"/"failed" → rejected.
 */
export function scriptedMobileDistribution(): ScriptedMobileDistribution {
  const bearersSeen: string[] = [];
  const scripts = new Map<string, string[]>();
  const polls = new Map<string, number>();
  let counter = 0;
  return {
    bearersSeen,
    scriptStates: (buildRef, states) => {
      scripts.set(buildRef, [...states]);
    },
    statusPolls: (buildRef) => polls.get(buildRef) ?? 0,
    async submit(input): Promise<MobileSubmissionResult> {
      bearersSeen.push(input.token);
      counter += 1;
      return { buildRef: `build_${counter}` };
    },
    async submissionStatus(input): Promise<MobileSubmissionStatus> {
      bearersSeen.push(input.token);
      const served = polls.get(input.buildRef) ?? 0;
      polls.set(input.buildRef, served + 1);
      const script = scripts.get(input.buildRef) ?? ["available"];
      const state = script[Math.min(served, script.length - 1)] as string;
      return {
        state,
        available: state === "available",
        rejected: state === "rejected" || state === "failed",
        buildRef: input.buildRef,
      };
    },
    async resolveArtifactIdentity(input) {
      bearersSeen.push(input.token);
      return { artifactDigest: SCRIPTED_ARTIFACT_DIGEST, providerChecksum: null };
    },
  };
}
