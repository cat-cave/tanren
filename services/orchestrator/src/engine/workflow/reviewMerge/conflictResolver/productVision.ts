// The production `ProductVisionReader` for the intent-preserving conflict
// resolver (engine/contracts/conflictResolution.ts). It loads — RLS-scoped,
// READ-ONLY, no new writes / no migration — the product vision the resolver
// frames a resolution against AND judges a genuine product-intent clash on:
//
//   - PERSONAS   : `PersonaStore.listForProject` (the project's personas + the
//                  org-scoped ones), with each persona's delivery SURFACE read
//                  back off the persona `metadata` jsonb (where the greenfield
//                  derive persists it, there being no `surface` column).
//   - BEHAVIORS  : `BehaviorStore.listForSpec` for BOTH conflicting specs — the
//                  persona-behaviors tied to the two specs, the surface where a
//                  genuine persona-behavior CONTRADICTION would show up. Each
//                  behavior is attributed to its persona (so the contradiction is
//                  attributable in the prompt). De-duped across the two specs.
//   - DESIGN-DNA : the captured product identity (`pitch`) + design note
//                  (`designDna`) persisted on `projects.config.productVision` by
//                  the greenfield interview derive (the interview capture is
//                  otherwise transient). Read read-only via `ProjectStore.get`.
//
// A genuinely EMPTY product (no personas, no behaviors, no design-DNA) returns an
// empty vision — never an error, never a stub. The resolver/prompt then omit the
// product-vision section (a real empty state). Required-but-failing reads throw
// LOUDLY (no silent degrade) — the empty case is ONLY a legitimately empty product.

import type pg from "pg";
import type { ActorContext } from "../../../../auth/schemas.js";
import { migrateProjectConfig } from "../../../config/projectConfig.js";
import type {
  ProductVision,
  ProductVisionBehavior,
  ProductVisionPersona,
  ProductVisionReader,
} from "../../../contracts/conflictResolution.js";
import { BehaviorStore, type BehaviorRow } from "../../../entities/behaviors.js";
import { PersonaStore, type PersonaRow } from "../../../entities/personas.js";
import { ProjectStore } from "../../../repositories/projects.js";

/** A pool or a checked-out (org-scoped) client — the run's already-scoped client. */
type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface PgProductVisionReaderDeps {
  /** The run's already org-scoped client (the same scope the resolver reads under). */
  client: QueryClient;
  /**
   * The org the run belongs to. The persona/behavior stores authorize via an
   * ActorContext: a platform-admin actor carrying THIS org admits the org-scoped
   * rows (the SAME pattern the DagWalker enqueuer / intake auto-route use). The
   * underlying client is still RLS-scoped to the org, so a cross-org row is both
   * unreadable AND un-attributable. When absent (a path with no resolved org —
   * e.g. a single-tenant dev run) the reader returns an empty vision rather than
   * inventing a tenant scope.
   */
  orgId?: string;
}

/**
 * The persona `metadata` shape the greenfield derive writes the SURFACE under
 * (the personas table has no `surface` column). Read defensively — a persona
 * created via another path carries no `surface` key (a real empty surface).
 */
function surfaceFromMetadata(metadata: PersonaRow["metadata"]): string | undefined {
  const raw = metadata["surface"];
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

export class PgProductVisionReader implements ProductVisionReader {
  constructor(private readonly deps: PgProductVisionReaderDeps) {}

  async read(input: { projectId: string; mergingSpecId: string; conflictingSpecId?: string }): Promise<ProductVision> {
    // No resolved org ⇒ no tenant to scope persona/behavior reads to. Return an
    // empty vision (a real empty state) rather than reading off the wrong scope.
    if (this.deps.orgId === undefined) {
      return { personas: [], behaviors: [] };
    }
    const actor = this.platformAdminActor(this.deps.orgId, input.projectId);

    const personaRows = await PersonaStore.listForProject(
      this.deps.client,
      { orgId: this.deps.orgId, projectId: input.projectId },
      actor,
    );
    const personas: ProductVisionPersona[] = personaRows.map((row) => toVisionPersona(row));
    const personaNameById = new Map(personaRows.map((row) => [row.id, row.name]));

    const behaviors = await this.loadBehaviors(input.mergingSpecId, input.conflictingSpecId, personaNameById, actor);
    const designDna = await this.loadDesignDna(input.projectId);

    return { personas, behaviors, ...(designDna !== undefined && { designDna }) };
  }

  /**
   * The persona-behaviors tied to BOTH conflicting specs (de-duped by behavior
   * id), each attributed to its persona so a contradiction is attributable. The
   * conflicting spec is optional (an un-attributed base-history conflict has none).
   */
  private async loadBehaviors(
    mergingSpecId: string,
    conflictingSpecId: string | undefined,
    personaNameById: Map<string, string>,
    actor: ActorContext,
  ): Promise<ProductVisionBehavior[]> {
    const specIds = conflictingSpecId === undefined ? [mergingSpecId] : [mergingSpecId, conflictingSpecId];
    const seen = new Set<string>();
    const out: ProductVisionBehavior[] = [];
    for (const specId of specIds) {
      const rows = await BehaviorStore.listForSpec(this.deps.client, specId, actor);
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(toVisionBehavior(row, personaNameById.get(row.personaId)));
      }
    }
    return out;
  }

  /**
   * The captured design-DNA + identity pitch off `projects.config.productVision`
   * (persisted by the greenfield derive; the interview capture is otherwise
   * transient). A project without an interview carries no `productVision` (a real
   * empty state) ⇒ undefined. A project that cannot be read at all is a LOUD fault.
   */
  private async loadDesignDna(projectId: string): Promise<string | undefined> {
    const project = await ProjectStore.get(this.deps.client, projectId, { kind: "system" });
    if (project === undefined) {
      throw new Error(`product-vision reader: project ${projectId} not found`);
    }
    const config = migrateProjectConfig(project.config);
    const vision = config.productVision;
    if (vision === undefined) return undefined;
    const parts = [vision.pitch, vision.designDna].filter((p): p is string => p !== undefined && p.trim() !== "");
    return parts.length > 0 ? parts.join(" — ") : undefined;
  }

  /**
   * A platform-admin actor carrying the run's org (the SAME pattern the DagWalker
   * enqueuer / autonomous intake use): it admits the org-scoped persona/behavior
   * rows while the underlying client stays RLS-scoped to the org.
   */
  private platformAdminActor(orgId: string, projectId: string): ActorContext {
    return {
      userId: "conflict-resolver",
      orgId,
      projectId,
      scopes: ["platform:admin"],
      source: "local_dev",
    };
  }
}

function toVisionPersona(row: PersonaRow): ProductVisionPersona {
  const surface = surfaceFromMetadata(row.metadata);
  return { name: row.name, description: row.description, ...(surface !== undefined && { surface }) };
}

function toVisionBehavior(row: BehaviorRow, personaName: string | undefined): ProductVisionBehavior {
  return {
    persona: personaName ?? row.personaId,
    title: row.title,
    given: row.given,
    when: row.when,
    thenOutcome: row.then,
  };
}
