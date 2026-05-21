# Roadmap Spec Template

Use this template for every roadmap node. The spec describes work and verification, not calendar time.

```markdown
## SPEC-XXXX - <slug>

**Phase**: A | B
**Owns**: list of file paths this spec produces
**Consumes**: list of SPEC-XXXX dependencies
**Produces**: list of contracts, files, or capabilities other specs can consume

**What**: One paragraph describing what this spec builds.
**Why**: One paragraph linking the work to a `PROJECT_BRIEF.md` section.
**How**: Implementation approach, key decisions, and rationale.

**Test plan**: Unit, integration, contract, or smoke checks.
**Quality bar**: What counts as done beyond tests passing.
**Real-functionality validation**: Observable behavior proving this works outside tests.

**Worktree-isolation safety**: Directories this spec exclusively writes so peer worktrees do not race.
```

Every spec must be small enough for a single agent to finish without crossing ownership boundaries.
