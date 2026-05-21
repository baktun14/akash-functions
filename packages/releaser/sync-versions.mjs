#!/usr/bin/env node
// Sync in-code version markers to the tag the publish workflows will cut on
// merge. Run on every `pull_request` synchronize so the PR carries the
// would-be-released version forward to readers (dashboard "needs update"
// prompt, runner self-report, debugging, etc.) instead of drifting until
// somebody bumps it by hand.
//
// Why the PR title, not the commits: GitHub squash-merges use the PR title as
// the merged commit message on main. The conventional-commits bumper in
// packages/releaser/recommended-bump.js scans that one commit, so the only
// thing that matters for the resulting tag is the PR title (and any `!` /
// `BREAKING CHANGE:` footer). Predicting from the PR title here matches what
// happens at merge time; analyzing individual commits would mis-predict
// whenever the PR title's bump-level differs from the commits inside.
//
// Trigger surface (per package):
//   runner  → `packages/runner/**` changes      → updates RUNNER_VERSION (boot.ts) +
//                                                   packages/runner/package.json version +
//                                                   EXPECTED_RUNNER_VERSION (server) + server
//                                                   package.json version (because the
//                                                   EXPECTED_RUNNER_VERSION write touches the
//                                                   server package, so server-publish will
//                                                   release on merge)
//   server  → `packages/server/**` changes      → updates packages/server/package.json
//   web     → `packages/web/**` changes         → updates packages/web/package.json
//
// Idempotent: if the in-code values already match the predicted next version,
// no files are written and no commit is produced. This is what stops the
// "bot pushes, workflow re-fires, bot pushes again" loop after the first run.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PR_TITLE = process.env.PR_TITLE;
const PR_BODY = process.env.PR_BODY ?? '';
const BASE_REF = process.env.BASE_REF || 'main';

if (!PR_TITLE) {
  console.error('PR_TITLE env var required');
  process.exit(1);
}

const TITLE_RE = /^(\w+)(?:\(([^)]+)\))?(!)?:\s/;
const titleMatch = PR_TITLE.match(TITLE_RE);
if (!titleMatch) {
  console.log(`PR title "${PR_TITLE}" is not conventional — nothing to sync.`);
  process.exit(0);
}
const [, type, , bang] = titleMatch;

// Match recommended-bump.js's `whatBump`:
//   0 = major   (breaking)
//   1 = minor   (feat)
//   2 = patch   (fix, refactor, perf)
//   undefined  (chore, docs, ci, test, style) — no release, exit cleanly
const BUMP_LEVELS = { feat: 1, feature: 1, fix: 2, refactor: 2, perf: 2 };
const hasBreakingFooter = /^BREAKING CHANGE:/m.test(PR_BODY);
const level = bang || hasBreakingFooter ? 0 : BUMP_LEVELS[type];

if (level === undefined) {
  console.log(`PR title type "${type}" is not releasable — nothing to sync.`);
  process.exit(0);
}

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function lastTagVersion(prefix) {
  // --sort=-version:refname puts the highest semver first; fall through to
  // [0,0,0] if no tag exists yet for this package.
  const out = sh(`git tag --list '${prefix}*' --sort=-version:refname`);
  if (!out) return [0, 0, 0];
  const top = out.split('\n')[0];
  const m = top.replace(prefix, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function applyBump([major, minor, patch], lvl) {
  if (lvl === 0) return [major + 1, 0, 0];
  if (lvl === 1) return [major, minor + 1, 0];
  if (lvl === 2) return [major, minor, patch + 1];
  return [major, minor, patch];
}

function nextVersionFor(prefix) {
  return applyBump(lastTagVersion(prefix), level).join('.');
}

function updateJsonVersion(path, value) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (json.version === value) return false;
  json.version = value;
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ${path}: version → ${value}`);
  return true;
}

function updateStringConst(path, name, value) {
  const before = readFileSync(path, 'utf8');
  const re = new RegExp(`(${name}\\s*=\\s*['"\`])[^'"\`]+(['"\`])`);
  if (!re.test(before)) {
    console.warn(`  ${path}: no ${name} = '...' assignment found, skipping`);
    return false;
  }
  const after = before.replace(re, `$1${value}$2`);
  if (before === after) return false;
  writeFileSync(path, after);
  console.log(`  ${path}: ${name} → ${value}`);
  return true;
}

const changedFiles = sh(`git diff --name-only origin/${BASE_REF}...HEAD`)
  .split('\n')
  .filter(Boolean);

const runnerTouched = changedFiles.some((f) => f.startsWith('packages/runner/'));
const userTouchedServer = changedFiles.some((f) => f.startsWith('packages/server/'));
const webTouched = changedFiles.some((f) => f.startsWith('packages/web/'));

// Any runner change implies we'll write to packages/server/src/lib/runner-version.ts,
// which causes server-publish to release on merge — so the server is always
// "touched" when the runner is, for version-tracking purposes.
const serverTouched = userTouchedServer || runnerTouched;

let didAnything = false;

if (runnerTouched) {
  const next = nextVersionFor('runner-v');
  console.log(`runner → ${next} (last tag → bump ${level})`);
  didAnything = updateStringConst('packages/runner/boot.ts', 'RUNNER_VERSION', next) || didAnything;
  didAnything = updateJsonVersion('packages/runner/package.json', next) || didAnything;
  didAnything =
    updateStringConst('packages/server/src/lib/runner-version.ts', 'EXPECTED_RUNNER_VERSION', next) ||
    didAnything;
}

if (serverTouched) {
  const next = nextVersionFor('server-v');
  console.log(`server → ${next} (last tag → bump ${level})`);
  didAnything = updateJsonVersion('packages/server/package.json', next) || didAnything;
}

if (webTouched) {
  const next = nextVersionFor('web-v');
  console.log(`web → ${next} (last tag → bump ${level})`);
  didAnything = updateJsonVersion('packages/web/package.json', next) || didAnything;
}

if (!didAnything) {
  console.log('All in-code versions already match the predicted next release.');
}
