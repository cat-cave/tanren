// ds-0 — the `DesignTargetAdapter` CONTRACT (foundation slot for ds-2..7).
//
// One framework projection behind one contract (design bucket §1 "framework
// adapters behind one contract"). Every target — web React/shadcn (ds-2), generic
// web, Bevy, SwiftUI/Compose/Flutter/RN, document/media (ds-7) — ships the SAME
// interface + the SAME adversarial conformance suite. An unsupported capability
// is a TYPED gap (`UnsupportedDesignCapabilityError`) that invokes F2D (ds-3); it
// is NEVER silently omitted or substituted.
//
// FOUNDATION ONLY: this file is the interface, the registry seam, and the typed
// gap error — the SLOT ds-2 fills with the real shadcn/Radix/Tailwind impl. No
// adapter body lives here; a registry with no registered adapter resolves to a
// loud "no adapter for target" — never a stub that pretends to render.

import type {
  DesignArtifactFileV1,
  DesignFragmentSpecV1,
  FrameworkDesignArtifactManifestV1,
} from "./designArtifactSchemas.js";

/** A resolved target profile: the adapter key + the capabilities it must satisfy. */
export interface DesignTargetProfile {
  readonly target: string;
  readonly capabilities: readonly string[];
}

/** The typed VFS operations a fragment's apply plan may perform (design bucket §1). */
export type DesignVfsOperation =
  | "addTokenSet"
  | "addMode"
  | "addAlias"
  | "addComponent"
  | "addScenario"
  | "addAsset"
  | "addExporter"
  | "addCatalogRoute";

/**
 * The typed design VFS the compiler materializes fragments onto. ds-0 declares the
 * READ-ONLY shape the adapter contract references; the mutable implementation
 * (constrained ops, collision/cycle detection) is ds-1. File collisions,
 * unresolved capabilities, undeclared dependencies, token cycles, or incompatible
 * adapters MUST fail loudly there — never a silent overwrite.
 */
export interface DesignVfsView {
  readonly files: readonly DesignArtifactFileV1[];
  fileAt(path: string): DesignArtifactFileV1 | undefined;
}

/** A deterministic check result an adapter's static/render validators return. */
export interface DesignAdapterCheckResult {
  readonly ok: boolean;
  readonly checkKey: string;
  readonly findings: readonly DesignAdapterFinding[];
}

/** A normalized finding — the currency the ordinary Writer loop repairs (design bucket §1 A4). */
export interface DesignAdapterFinding {
  readonly code: string;
  readonly severity: "p0" | "p1" | "p2" | "p3";
  readonly message: string;
  readonly path?: string;
}

/** One render-scenario the adapter's matrix enumerates (component × theme × viewport …). */
export interface DesignRenderScenario {
  readonly scenarioKey: string;
  readonly component: string;
  readonly theme: string;
  readonly viewport: string;
  readonly locale: string;
  readonly personaRef?: string;
  readonly behaviorRef?: string;
}

/** A proof requirement the adapter declares for the native gate (ds-4). */
export interface DesignProofRequirement {
  readonly key: string;
  readonly kind: "build" | "token" | "accessibility" | "interaction" | "render" | "export";
  readonly critical: boolean;
}

/**
 * The framework projection contract. Method NAMES + intents are frozen here (the
 * ds-2 slot); the bodies are per-adapter. Every method is async-capable and MUST
 * fail loudly on an unsupported capability (see `UnsupportedDesignCapabilityError`)
 * rather than emit a partial/placeholder projection.
 */
export interface DesignTargetAdapter {
  /** The adapter's target key (matches `DesignTargetProfile.target`). */
  readonly target: string;

  /** Detect whether this adapter applies to a workspace, and at what capability level. */
  detectTarget(workspace: DesignAdapterWorkspace): Promise<DesignTargetDetection>;

  /** Compose the deliberately-plain base system for this target (design bucket §1 "plain base"). */
  bootstrapPlainSystem(profile: DesignTargetProfile): Promise<DesignVfsView>;

  /** Materialize a resolved fragment graph onto the VFS, emitting real source/assets. */
  materialize(fragmentGraph: readonly DesignFragmentSpecV1[], vfs: DesignVfsView): Promise<DesignVfsView>;

  /** Build the isolated catalog (Storybook-compatible for web) from the materialized VFS. */
  buildCatalog(vfs: DesignVfsView): Promise<DesignArtifactFileV1[]>;

  /** Deterministic static checks (schema, DTCG resolution, build, exports). */
  validateStatic(vfs: DesignVfsView): Promise<DesignAdapterCheckResult>;

  /** Enumerate the risk-selected render-scenario matrix for A4 (ds-4). */
  renderScenarioMatrix(vfs: DesignVfsView, profile: DesignTargetProfile): Promise<DesignRenderScenario[]>;

  /** Emit one export projection (css, tailwind, shadcn-registry, …). */
  export(format: string, manifest: FrameworkDesignArtifactManifestV1): Promise<DesignArtifactFileV1[]>;

  /** The proof requirements the native gate must satisfy for this target. */
  enumerateProofRequirements(profile: DesignTargetProfile): Promise<DesignProofRequirement[]>;
}

/** The isolated workspace an adapter inspects — no secrets, no orchestrator eval. */
export interface DesignAdapterWorkspace {
  readonly root: string;
  listFiles(): Promise<readonly string[]>;
}

/** The outcome of `detectTarget`: whether the adapter applies + which capabilities it can satisfy. */
export interface DesignTargetDetection {
  readonly applies: boolean;
  readonly satisfiedCapabilities: readonly string[];
  readonly unsatisfiedCapabilities: readonly string[];
}

/**
 * A required capability the resolved adapter cannot satisfy. This is the TYPED
 * gap that invokes F2D (ds-3) — the design system authors the missing
 * target/component/exporter rather than substituting "closest available". It is
 * NEVER swallowed into a partial projection.
 */
export class UnsupportedDesignCapabilityError extends Error {
  constructor(
    readonly target: string,
    readonly capability: string,
  ) {
    super(`design target '${target}' cannot satisfy capability '${capability}' — F2D authoring required`);
    this.name = "UnsupportedDesignCapabilityError";
  }
}

/** Raised when no adapter is registered for a requested target — loud, never a stub render. */
export class DesignAdapterNotRegisteredError extends Error {
  constructor(readonly target: string) {
    super(`no design target adapter registered for '${target}'`);
    this.name = "DesignAdapterNotRegisteredError";
  }
}

/**
 * The adapter REGISTRY seam. ds-2..7 register their impls at construction; the
 * engine resolves an adapter by target key. Resolving an unregistered target is a
 * loud typed error, mirroring the slottable-adapter doctrine (a backend is a new
 * registry entry, not a refactor).
 */
export class DesignTargetAdapterRegistry {
  private readonly adapters = new Map<string, DesignTargetAdapter>();

  register(adapter: DesignTargetAdapter): void {
    if (this.adapters.has(adapter.target)) {
      throw new Error(`duplicate design target adapter registration for '${adapter.target}'`);
    }
    this.adapters.set(adapter.target, adapter);
  }

  resolve(target: string): DesignTargetAdapter {
    const adapter = this.adapters.get(target);
    if (adapter === undefined) {
      throw new DesignAdapterNotRegisteredError(target);
    }
    return adapter;
  }

  has(target: string): boolean {
    return this.adapters.has(target);
  }

  registeredTargets(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

/**
 * The adversarial CONFORMANCE-SUITE contract every adapter must pass (design
 * bucket §1: "every adapter ships the same adversarial conformance suite"). ds-0
 * fixes the shape; ds-2 lands the web suite. A suite MUST include NEGATIVE
 * CONTROLS (intentionally broken contrast/focus/alias/layout) that the adapter's
 * validators are REQUIRED to fail — proving the gate catches regressions.
 */
export interface DesignAdapterConformanceSuite {
  readonly target: string;
  readonly positiveCases: readonly DesignConformanceCase[];
  readonly negativeControls: readonly DesignConformanceCase[];
}

export interface DesignConformanceCase {
  readonly key: string;
  readonly description: string;
  /** For a negative control, the check that MUST report a finding. */
  readonly expectFinding?: string;
}
