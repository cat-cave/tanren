/**
 * commitlint (Track B wave 5) — enforce Conventional Commits on commit-msg.
 * Wired through lefthook's commit-msg hook alongside the existing mergify
 * change-id hooks. Uses the standard conventional-commit ruleset.
 */
export default {
  extends: ["@commitlint/config-conventional"],
};
