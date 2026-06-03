// The zod row-decoders for `loadSpecWithProject` (projectSpec.ts): tolerant
// transforms for the jsonb `config` blob and the text[] array columns, plus the
// joined spec+project row schema. Extracted to keep projectSpec.ts under its
// max-lines cap; behavior is unchanged (a plain re-home of the schemas).

import { z } from "zod";
import { SpecPriority } from "../state/spec.js";

/** A jsonb object column → a record, defaulting non-objects (incl. arrays/null) to `{}`. */
const RecordOrEmpty = z
  .unknown()
  .transform((value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
  );

/** A text[] column → a string[], dropping non-string members and defaulting non-arrays to `[]`. */
const StringArrayOrEmpty = z
  .unknown()
  .transform((value) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []));

/** The joined `specs s JOIN projects p` row `loadSpecWithProject` decodes. */
export const SpecProjectRowSchema = z.object({
  project_id: z.string(),
  name: z.string(),
  repo_url: z.string(),
  default_branch: z.string(),
  runner_image: z.string(),
  allocator: z.string(),
  config: RecordOrEmpty,
  spec_id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: StringArrayOrEmpty,
  depends_on: StringArrayOrEmpty,
  status: z.string(),
  priority: SpecPriority,
});
