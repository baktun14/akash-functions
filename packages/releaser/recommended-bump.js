// Conventional-commits version bumper. Mirrors the pattern used in
// akash-network/console (packages/releaser/recommended-bump.js) but trimmed:
// this repo only ships one releasable artifact (the runner image), so we
// drop the multi-app/local-package-dependency machinery.
//
// Usage:
//   node packages/releaser/recommended-bump.js \
//     --tag-prefix=runner-v \
//     --path packages/runner \
//     --repo-url https://github.com/baktun14/akash-functions \
//     --target-sha <sha>
//
// Emits a single JSON line on stdout:
//   { currentVersion, nextVersion, nextTag, changelog, analyzedCommitsCount }
// or { error: "..." } and exits 0 when there are no releasable commits.

import conventionalChangelogConventionalCommits from "conventional-changelog-conventionalcommits";
import { Bumper } from "conventional-recommended-bump";
import { parseArgs } from "node:util";

const { values: cliOptions } = parseArgs({
  options: {
    "tag-prefix": { type: "string" },
    "repo-url": { type: "string" },
    path: { type: "string" },
    "target-sha": { type: "string" }
  }
});

const COMMIT_TYPES = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "refactor", section: "Code Refactoring" },
  { type: "perf", section: "Performance Improvements" },
  { type: "test", hidden: true },
  { type: "chore", hidden: true },
  { type: "ci", hidden: true },
  { type: "docs", hidden: true },
  { type: "style", hidden: true }
];

const bumper = new Bumper(process.cwd());
bumper.loadPreset("conventionalcommits");

if (cliOptions["tag-prefix"]) {
  bumper.tag({ prefix: cliOptions["tag-prefix"] });
}
if (cliOptions.path) {
  bumper.commits({ path: [cliOptions.path] });
}

const lastTag = await bumper.getLastSemverTag();
const { commits: analyzedCommits } = await bumper.bump();

// Process commits oldest-first so each commit's version is derived from those
// before it. This makes version computation deterministic regardless of when
// the workflow runs.
const commits = [...analyzedCommits].reverse();

const prefix = cliOptions["tag-prefix"] || "";
const initialVersion = lastTag ? lastTag.replace(prefix, "") : "0.0.0";
let [major, minor, patch] = initialVersion.split(".").map(Number);

let targetCommit = null;
let targetCommitReleaseLevel;

for (const commit of commits) {
  const { level } = whatBump([commit]);

  if (level === 0) {
    major++;
    minor = 0;
    patch = 0;
  } else if (level === 1) {
    minor++;
    patch = 0;
  } else if (level === 2) {
    patch++;
  }

  if (!cliOptions["target-sha"] || commit.hash === cliOptions["target-sha"]) {
    targetCommit = commit;
    targetCommitReleaseLevel = level;
    break;
  }
}

if (!targetCommit || targetCommitReleaseLevel === undefined) {
  console.log(JSON.stringify({ error: "No releasable commit found for this SHA" }));
  process.exit(0);
}

const nextVersion = `${major}.${minor}.${patch}`;
const nextTag = `${prefix}${nextVersion}`;
const repoUrl = cliOptions["repo-url"] || "";
const { writer: changelogWriter } = await conventionalChangelogConventionalCommits({ types: COMMIT_TYPES });

console.log(
  JSON.stringify({
    analyzedCommitsCount: analyzedCommits.length,
    currentVersion: initialVersion,
    nextVersion,
    nextTag,
    changelog: buildChangelog({ targetCommit, repoUrl, lastTag, nextTag, nextVersion, changelogWriter })
  })
);

function buildChangelog({ targetCommit, repoUrl, lastTag, nextTag, nextVersion, changelogWriter }) {
  const [, owner, repository] = repoUrl.match(/github\.com\/([^/]+)\/(.+)$/) ?? [];
  const transformed = changelogWriter.transform(targetCommit, {
    host: "https://github.com",
    owner: owner || "",
    repository: repository || "",
    repoUrl,
    linkReferences: !!repoUrl
  });
  const date = new Date().toISOString().split("T")[0];
  const compareUrl = lastTag ? `${repoUrl}/compare/${lastTag}...${nextTag}` : `${repoUrl}/commits/${nextTag}`;
  const scope = transformed.scope ? `**${transformed.scope}:** ` : "";
  const hash = transformed.shortHash ? ` ([${transformed.shortHash}](${repoUrl}/commit/${targetCommit.hash}))` : "";
  const lines = [`## [${nextVersion}](${compareUrl}) (${date})`, "", `### ${transformed.type}`, "", `* ${scope}${transformed.subject}${hash}`];
  if (transformed.notes?.length) {
    lines.push("", "### ⚠ BREAKING CHANGES", "");
    lines.push(...transformed.notes.map((note) => `* ${note.text}`));
  }
  return lines.join("\n");
}

function whatBump(commits) {
  let level;
  let breakings = 0;
  let features = 0;

  commits.forEach((commit) => {
    const isHiddenType = COMMIT_TYPES.find((t) => t.type === commit.type)?.hidden || false;
    addBangNotes(commit);

    if (commit.notes.length > 0) {
      breakings += commit.notes.length;
      level = 0;
    } else if (commit.type === "feat" || commit.type === "feature") {
      features += 1;
      if (level === 2 || level === undefined) level = 1;
    } else if (!isHiddenType && level === undefined) {
      level = 2;
    }
  });

  return {
    level,
    reason:
      breakings === 1
        ? `There is ${breakings} BREAKING CHANGE and ${features} features`
        : `There are ${breakings} BREAKING CHANGES and ${features} features`
  };
}

function addBangNotes(commit) {
  const match = commit.header.match(/^(\w*)(?:\((.*)\))?!: (.*)$/);
  if (match && commit.notes.length === 0) {
    commit.notes.push({ text: match[3] });
  }
}
