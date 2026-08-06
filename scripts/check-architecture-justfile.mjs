// Justfile architecture rules. Two related gates, both about the same hazard:
// `just` treats `#` as a comment to end of line, INCLUDING on a recipe's
// dependency line. A `#` pasted mid-list silently deletes every dependency
// after it, and `just` reports success having never run them.
//
// That is what happened to `smoke:` (a single ~2.5 KB dependency line): three
// real-Postgres RLS proofs — post-merge behavior verdict, verification reads,
// proof dashboard — were defined-but-unreachable for weeks. `just smoke` is
// step 2 of ci-heavy.yml, the merge-queue gate, so it went green on every merge
// without executing them. A silently-skipped tenant-isolation proof is worse
// than a failing one: the suite says the property holds and nothing checked it.
//
// `smoke-recipes-reachable` is the rule that closes it: reachability is the
// property we actually care about, and a truncated dependency list can only
// ever make a leaf unreachable. `justfile-no-inline-comment-in-dependencies`
// names the mechanism, so a truncation is reported where it happened rather
// than as a distant symptom, and covers dependency lists on OTHER recipes too.
//
// See docs/contracts/architecture-checks.md.

const JUSTFILE = "justfile";
// `smoke` is the operator-facing wrapper; its body validates configuration and
// invokes this dependency-only graph root. Keep the architecture walk rooted at
// the leaf list so a wrapper mutation cannot mask a dropped aggregate edge.
const SMOKE_AGGREGATE = "smoke-aggregate";
const SMOKE_PREFIX = "smoke-";

// `smoke-*` recipes deliberately NOT part of the merge-queue aggregate. EMPTY —
// every smoke recipe in the tree is reachable from the `smoke-aggregate` graph
// root today. The operator-facing `smoke` wrapper invokes that root. Adding an
// entry requires a matching note in docs/contracts/architecture-checks.md.
const smokeAggregateExclusions = new Set();

const RECIPE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/u;
// `just <flags> <recipe>` inside a recipe body. `smoke-rls-remediation-attempts`
// invokes `smoke-rls-repair-routing` this way, so a dependency-only walk would
// report a recipe that demonstrably runs. Matches are intersected with the set
// of real recipe names, so prose that merely mentions a non-recipe word is inert.
const BODY_INVOCATION = /\bjust\s+(?:-{1,2}[^\s]+\s+)*([A-Za-z0-9_][A-Za-z0-9_-]*)/gu;

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

// Split a justfile line at the first `#` that is not inside a quoted string —
// `just`'s own comment rule. Reproducing it is the POINT: whatever a comment
// swallows, this parser must lose too. A more forgiving parser that recovered
// the truncated names would silently repair the defect it exists to catch.
function splitComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      return { code: line.slice(0, index), comment: line.slice(index) };
    }
  }
  return { code: line, comment: "" };
}

// Index of the `:` that opens a recipe's dependency list, or -1 when the line is
// not a recipe signature. Skips quoted strings and parameter-default parens, and
// rejects `:=` so assignments (`set shell := …`, `export X := …`, `alias a := b`)
// are not read as recipes.
function findDependencyColon(code) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === ":" && depth === 0) {
      return code[index + 1] === "=" ? -1 : index;
    }
  }
  return -1;
}

function dependencyNames(section) {
  const names = [];
  // Drop `dep(arg)` argument groups before splitting, so an argument containing
  // whitespace cannot be read as a dependency of its own.
  for (const token of section.replaceAll(/\([^)]*\)/gu, " ").split(/\s+/u)) {
    const name = token.replace(/^@/u, "");
    // `&&` separates post-dependencies (which still run) from the rest.
    if (name !== "" && name !== "&&" && RECIPE_NAME.test(name)) {
      names.push(name);
    }
  }
  return names;
}

// Read a recipe signature starting at `start`, following `\` continuations the
// way `just` does. Comments are stripped BEFORE the continuation test, because a
// `\` inside a comment does not continue the line.
function readSignature(lines, start) {
  const segments = [];
  let index = start;
  for (;;) {
    const { code, comment } = splitComment(lines[index] ?? "");
    const continues = code.trimEnd().endsWith("\\");
    segments.push({ line: index + 1, code, comment, continues });
    if (!continues || index + 1 >= lines.length) {
      break;
    }
    index += 1;
  }
  const pieces = segments.map((segment) => (segment.continues ? segment.code.trimEnd().slice(0, -1) : segment.code));
  const joined = pieces.join(" ");
  const colon = findDependencyColon(joined);
  if (colon === -1) {
    return null;
  }
  const name = joined.slice(0, colon).trim().split(/\s+/u)[0]?.replace(/^@/u, "") ?? "";
  if (!RECIPE_NAME.test(name)) {
    return null;
  }
  // Which segments carry a comment that lands AFTER the dependency colon.
  const commented = [];
  let offset = 0;
  for (const [position, segment] of segments.entries()) {
    const end = offset + pieces[position].length;
    if (segment.comment !== "" && end > colon) {
      commented.push(segment);
    }
    offset = end + 1;
  }
  return {
    name,
    line: start + 1,
    endIndex: index,
    dependencies: dependencyNames(joined.slice(colon + 1)),
    commented,
  };
}

// A recipe body is every following line that is blank or indented.
function readBody(lines, start) {
  let index = start;
  while (index < lines.length && (lines[index] === "" || /^\s/u.test(lines[index]))) {
    index += 1;
  }
  return { text: lines.slice(start, index).join("\n"), endIndex: index };
}

export function parseJustfileRecipes(text) {
  const lines = text.split("\n");
  const recipes = new Map();
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index];
    // Recipe signatures start at column 0. Comments and `[attribute]` lines do not.
    if (raw === "" || /^\s/u.test(raw) || raw.startsWith("#") || raw.startsWith("[")) {
      index += 1;
      continue;
    }
    const signature = readSignature(lines, index);
    if (signature === null) {
      index += 1;
      continue;
    }
    const body = readBody(lines, signature.endIndex + 1);
    recipes.set(signature.name, {
      line: signature.line,
      dependencies: signature.dependencies,
      commented: signature.commented,
      body: body.text,
    });
    index = body.endIndex;
  }
  return recipes;
}

function invokedFromBody(body, recipes) {
  const names = [];
  for (const match of body.matchAll(BODY_INVOCATION)) {
    if (recipes.has(match[1])) {
      names.push(match[1]);
    }
  }
  return names;
}

function reachableRecipes(recipes, root) {
  const reached = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const name = pending.pop();
    const recipe = recipes.get(name);
    if (recipe === undefined || reached.has(name)) {
      continue;
    }
    reached.add(name);
    pending.push(...recipe.dependencies, ...invokedFromBody(recipe.body, recipes));
  }
  return reached;
}

// Every `smoke-*` recipe must actually run when `just smoke` runs. A recipe that
// is defined but unreachable from the aggregate is coverage that exists on paper
// and executes nowhere — the merge-queue gate goes green without it.
export function checkSmokeRecipesReachable(projectFiles) {
  const justfile = projectFiles.find((item) => item.file === JUSTFILE);
  if (justfile === undefined) {
    return [];
  }
  const recipes = parseJustfileRecipes(justfile.text);
  const smoke = [...recipes.keys()].filter(
    (name) => name.startsWith(SMOKE_PREFIX) && !smokeAggregateExclusions.has(name),
  );
  // Nothing to lose track of. A tree with no `smoke-*` recipes has no coverage that
  // could silently fall out of the aggregate, so the rule has nothing to say. The
  // absent cases it declines to invent a diagnostic for — no justfile, or a justfile
  // with no smoke recipes — are LOUD failures anyway (`just smoke` does not exist, so
  // ci-heavy step 2 errors outright), not the silent-green failure this rule exists
  // for. Firing here instead flagged every synthetic fixture in the sibling specs.
  if (smoke.length === 0) {
    return [];
  }
  if (!recipes.has(SMOKE_AGGREGATE)) {
    return [
      diagnostic(
        "smoke-recipes-reachable",
        JUSTFILE,
        `the \`${SMOKE_AGGREGATE}\` aggregate recipe is missing, but ${smoke.length} \`${SMOKE_PREFIX}*\` recipe(s) are defined — none of them can run`,
      ),
    ];
  }
  const reached = reachableRecipes(recipes, SMOKE_AGGREGATE);
  return [...recipes.entries()]
    .filter(([name]) => name.startsWith(SMOKE_PREFIX) && !smokeAggregateExclusions.has(name) && !reached.has(name))
    .map(([name, recipe]) =>
      diagnostic(
        "smoke-recipes-reachable",
        JUSTFILE,
        `\`${name}\` is defined but unreachable from \`just ${SMOKE_AGGREGATE}\` — the merge-queue gate reports green without running it; add it to the \`${SMOKE_AGGREGATE}\` dependency list`,
        recipe.line,
      ),
    );
}

// A `#` anywhere in a dependency list deletes the rest of that list. Doc comments
// belong on their own line ABOVE the recipe, where `just` attributes them to it.
export function checkNoInlineCommentInDependencies(projectFiles) {
  const justfile = projectFiles.find((item) => item.file === JUSTFILE);
  if (justfile === undefined) {
    return [];
  }
  const diagnostics = [];
  for (const [name, recipe] of parseJustfileRecipes(justfile.text)) {
    for (const segment of recipe.commented) {
      diagnostics.push(
        diagnostic(
          "justfile-no-inline-comment-in-dependencies",
          JUSTFILE,
          `\`${name}\`: \`#\` in a dependency list silently deletes every dependency after it — move the comment to its own line above the recipe`,
          segment.line,
        ),
      );
    }
  }
  return diagnostics;
}

// A check that can silently NOT RUN is indistinguishable from one that ran and
// passed — the property this whole gate exists because of. So on success the gate
// NAMES what it verified rather than only speaking when something is wrong: the
// count lands in CI output, and a recipe quietly leaving the tree or the aggregate
// moves a number someone can see. Returns null when there is nothing to describe.
export function describeSmokeCoverage(projectFiles) {
  const justfile = projectFiles.find((item) => item.file === JUSTFILE);
  if (justfile === undefined) {
    return null;
  }
  const recipes = parseJustfileRecipes(justfile.text);
  if (!recipes.has(SMOKE_AGGREGATE)) {
    return null;
  }
  const reached = reachableRecipes(recipes, SMOKE_AGGREGATE);
  const smoke = [...recipes.keys()].filter((name) => name.startsWith(SMOKE_PREFIX));
  const covered = smoke.filter((name) => reached.has(name));
  return `smoke aggregate: ${covered.length}/${smoke.length} smoke-* recipes reachable from \`just ${SMOKE_AGGREGATE}\``;
}

export function runJustfileChecks(projectFiles) {
  return [...checkSmokeRecipesReachable(projectFiles), ...checkNoInlineCommentInDependencies(projectFiles)];
}
