// The FAIL-CLOSED live-jj seams for the production `BaseShiftCoordinator`
// (tanren-owns-the-engine.md §3 never-discard, §0 fail-closed boundary), split from
// `baseShiftCoordinatorPg.ts` to keep each file under the class-per-file cap.
//
// Until Wave 3 plumbs the live runner allocation + jj clone + real re-gate +
// answerer-backed resolver (the same scale of integration as `driveConflictResolve.ts`,
// landing with the proof-reuse cache + metrics), a base shift on the LIVE engine HOLDS:
// the opener/re-gate/resolver throw `BaseShiftHeldError`, so the dependent's run row +
// branch SURVIVE (never-discard) and are retried on the next notification — NEVER a
// silent discard, NEVER a silent merge. This is the §0 boundary made literal: an
// unplumbed capability is a LOUD hold, never a quiet degrade to a default.

import type { WorkspaceVcsCore } from "../contracts/workspaceVcsCore.js";
import {
  BaseShiftHeldError,
  type BaseShiftConflictResolver,
  type BaseShiftReGate,
  type BaseShiftWorkspaceOpener,
} from "./baseShiftCoordinator.js";

/** Fail-closed: the live-jj workspace open is Wave-3-plumbed — a base shift HOLDS. */
export class HeldBaseShiftWorkspaceOpener implements BaseShiftWorkspaceOpener {
  async open(): Promise<never> {
    throw new BaseShiftHeldError(
      "rebase",
      "live-jj base-shift workspace open is Wave-3-plumbed; holding the dependent's work (never-discard)",
    );
  }
}

/** Fail-closed: the live base-shift re-gate is Wave-3-plumbed — never merge unverified. */
export class HeldBaseShiftReGate implements BaseShiftReGate {
  async reGate(): Promise<never> {
    throw new BaseShiftHeldError(
      "regate",
      "live base-shift re-gate is Wave-3-plumbed; holding (never merge unverified)",
    );
  }
}

/** Fail-closed: the live base-shift conflict resolve is Wave-3-plumbed — the work survives. */
export class HeldBaseShiftConflictResolver implements BaseShiftConflictResolver {
  async resolve(): Promise<never> {
    throw new BaseShiftHeldError(
      "resolve",
      "live base-shift conflict resolve is Wave-3-plumbed; holding the recorded conflict (work survives)",
    );
  }
}

/**
 * A `WorkspaceVcsCore` placeholder for the production wiring: the live jj core is
 * constructed in Wave 3 from the runner allocation the held opener will provide. Until
 * then the held opener throws BEFORE any workspace op runs, so these methods are
 * UNREACHABLE on the live path — they throw loudly to keep the never-discard boundary
 * literal (no method here can silently mutate or discard).
 */
export class HeldWorkspaceVcsCore implements WorkspaceVcsCore {
  private held(): never {
    throw new BaseShiftHeldError(
      "rebase",
      "live-jj WorkspaceVcsCore is Wave-3-plumbed (unreachable behind the held opener)",
    );
  }
  openWorkspace(): never {
    this.held();
  }
  branch(): never {
    this.held();
  }
  checkout(): never {
    this.held();
  }
  commit(): never {
    this.held();
  }
  rebaseOnto(): never {
    this.held();
  }
  resolveConflict(): never {
    this.held();
  }
  restackDescendants(): never {
    this.held();
  }
  exportCleanGitRef(): never {
    this.held();
  }
  opUndo(): never {
    this.held();
  }
}
