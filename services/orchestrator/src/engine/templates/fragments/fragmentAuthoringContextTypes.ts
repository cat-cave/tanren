// fix/f2-prompt-hardening: the semi-structured context types the F2 writer prompt
// renders. Extracted from `fragmentAuthoringRun.ts` so that file stays under the
// 500-line cap; the runtime plumbing (`buildFragmentAuthoring` + `authorOneFragment`)
// lives with the runner, the type surface lives here.

/** SEMI-STRUCTURED PRODUCT CONTEXT — the parent spec's acceptance criteria + the
 * captured personas + behaviors that the writer uses to make DOMAIN-INFORMED
 * defaults (a db fragment for a "link shortener with click counts" should model
 * `links(id, url, clicks)` roughly, not a generic `Item` table).
 *
 * All fields OPTIONAL: the derive path passes what it captured; callers with no
 * product context (a test seam, an out-of-band manual re-run) leave them undefined
 * and the writer prompt omits the section cleanly. A field present but empty
 * (`personas: []`) is treated the same as absent — the section only renders when
 * something meaningful is available. */
export interface ProductContext {
  /** The parent spec's acceptance criteria — free-form lines, natural sentences.
   * Renders as a bullet list under `Acceptance criteria:`. */
  acceptanceCriteria?: readonly string[];
  /** Personas the interview captured. `name` is the natural key the LLM sees; the
   * derive path resolves persona ids elsewhere. */
  personas?: readonly { name: string; description: string; surface?: string }[];
  /** BDD-shaped behaviors the interview captured — `persona::title` is the natural
   * key. `given`/`when`/`then` are collapsed into a single readable acceptance
   * line in the prompt. */
  /* eslint-disable unicorn/no-thenable */
  behaviors?: readonly {
    persona: string;
    title: string;
    given?: string;
    when?: string;
    then?: string;
  }[];
  /* eslint-enable unicorn/no-thenable */
}

/** A lightweight PRIOR-FRAGMENT projection the F2 writer prompt renders. The
 * production wiring pulls these from `FragmentsStore.listValidatedByOrg` under an
 * org-scoped `QueryClient` (RLS bounds visibility to the caller's org). Tests
 * inject an in-memory list. Empty ⇒ the prompt section is OMITTED. */
export interface PriorFragment {
  fragmentId: string;
  kind: string;
  label: string;
}
