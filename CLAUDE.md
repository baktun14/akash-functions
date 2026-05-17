# CLAUDE.md

Project-specific guidance for Claude Code sessions in this repo. Keep this short and load-bearing — generic best-practices belong elsewhere.

## Conventional-commit prefix is REQUIRED on every PR title

The three publish workflows ([web-publish.yml](.github/workflows/web-publish.yml), [server-publish.yml](.github/workflows/server-publish.yml), [runner-publish.yml](.github/workflows/runner-publish.yml)) all gate releases on [packages/releaser/recommended-bump.js](packages/releaser/recommended-bump.js), which scans commits on `main` and only cuts a new `<svc>-v*` tag when it finds a recognized type. **If no tag is cut, the rebind step falls back to the previous tag — your changes build a fresh image but the lease gets pointed at the OLD release, so prod silently stays on the prior version.**

GitHub uses the **PR title** as the default squash-merge commit message. Individual commits inside the PR can be perfectly conventional, but if the PR title isn't, the merge commit on `main` won't be either.

### Recognized types

| Prefix | Bump | Triggers release? |
|---|---|---|
| `feat:` / `feat(scope):` | minor | yes |
| `fix:` / `fix(scope):` | patch | yes |
| `refactor:` / `perf:` | patch | yes |
| `<type>!:` or `BREAKING CHANGE:` footer | major | yes |
| `chore:` / `docs:` / `ci:` / `test:` / `style:` | none | no — use these when no release should be cut |

Scope SHOULD match the affected package: `feat(web):`, `fix(server):`, `fix(runner):`. For cross-cutting changes, omit scope.

### Before merging — checklist

- [ ] PR title starts with a conventional prefix from the table above.
- [ ] If the PR touches `packages/<svc>/**`, the prefix is `feat`/`fix`/`refactor`/`perf` (a release MUST be cut, or prod won't update).
- [ ] If the PR is docs/CI/chore-only, use `chore:` / `docs:` / `ci:` — no release will (or should) be cut.

### How to recover when this rule is missed

1. Land a tiny follow-up commit on `main` whose message has the right prefix (e.g. `fix(web): retag for <feature>`). The releaser will pick it up on the next push and cut the missing version.
2. Or manually `gh release create <svc>-v<next> --target <sha> --notes "..."` and re-run the corresponding publish workflow via `workflow_dispatch`.

### Reference incident

PR #62 (`onboarding: hero demo animation + scope copy fix`) merged without a `feat:` / `fix:` prefix. The web-publish workflow ran green, but the `Compute next version` job returned `"No releasable commit found for this SHA"`, no `web-v*` tag was created, and the rebind step rebound the lease to the previous `web-v1.16.4` image. Prod stayed on the pre-PR-#62 bundle until a follow-up commit was landed.
