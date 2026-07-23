#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
let repository = "cat-cave/tanren";
let sort = "updated";

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--repo") {
    repository = args[index + 1] ?? "";
    index += 1;
  } else if (argument === "--sort") {
    sort = args[index + 1] ?? "";
    index += 1;
  } else if (argument === "--help" || argument === "-h") {
    console.log("Usage: node scripts/cra/list-open-prs.mjs [--repo OWNER/REPO] [--sort updated|priority]");
    process.exit(0);
  } else {
    throw new Error(`unknown argument: ${argument}`);
  }
}

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("--repo must be OWNER/REPO");
if (sort !== "updated" && sort !== "priority") throw new Error("--sort must be updated or priority");

const fields = "number,title,author,baseRefName,headRefName,isDraft,labels,mergeStateStatus,updatedAt,url";
const raw = execFileSync(
  "gh",
  ["pr", "list", "--repo", repository, "--state", "open", "--limit", "100", "--json", fields],
  {
    encoding: "utf8",
  },
);
const priority = (labels) => {
  const name = labels.map((label) => label.name).find((label) => /^P[1-3]$/u.test(label));
  return name === "P1" ? 1 : name === "P2" ? 2 : name === "P3" ? 3 : 4;
};
const prs = JSON.parse(raw).sort((left, right) =>
  sort === "priority"
    ? priority(left.labels) - priority(right.labels) || right.updatedAt.localeCompare(left.updatedAt)
    : right.updatedAt.localeCompare(left.updatedAt),
);

console.log(`Open PRs for ${repository} (sorted by ${sort})`);
for (const pr of prs) {
  const labels = pr.labels.map((label) => label.name).join(",") || "-";
  console.log(
    `#${pr.number}\t${pr.isDraft ? "draft" : "ready"}\t${pr.mergeStateStatus}\t${pr.updatedAt}\t${pr.author.login}\t${labels}\t${pr.title}\t${pr.url}`,
  );
}
