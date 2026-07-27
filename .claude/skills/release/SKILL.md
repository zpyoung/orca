---
name: release
description: Use when cutting a release of the zpyoung/orca fork, or when asked to update CHANGELOG.md with fork-owned changes. Records commits this fork owns (not upstream's), computes a fork version anchored to the upstream point main is built on, and dispatches release-cut.yml. Triggers on "cut a release", "release the fork", "update the changelog", "ship a build".
---

# Releasing the fork

`zpyoung/orca` is a consumption fork of `stablyai/orca`. A release answers two questions:
**what did this fork change** (`CHANGELOG.md`) and **what upstream is it built on** (the version).

This skill writes the changelog and dispatches the existing release pipeline. It does **not** sync
upstream, and it does **not** run typecheck/lint/tests — CI owns verification.

Arguments: `--yes` skips the confirmation prompt (for unattended automation runs).

## 1. Check preconditions

Stop and report if any fail. Do not write anything before all four pass.

```sh
git rev-parse --abbrev-ref HEAD        # must be: main
git status --porcelain                 # must be empty
git fetch origin main
git fetch upstream
git rev-list --count origin/main..HEAD # must be: 0
```

## 2. Resolve the release inputs

```sh
MERGE_BASE=$(git merge-base upstream/main HEAD)
ANCHOR=$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$MERGE_BASE")
GAP=$(git rev-list --count HEAD..upstream/main)
```

Read `last_released_commit` and `upstream_synced` from `CHANGELOG.md`'s YAML frontmatter, then
list candidate commits:

```sh
git log --no-merges --format='%H%x09%an%x09%s' "$LAST_RELEASED_COMMIT"..HEAD
```

**Exclude bot-authored commits** — any author containing `[bot]`. This drops the recurring
`Update README downloads badge` commit and release-cut's own version-bump commit. What remains is
the set of fork commits needing changelog entries.

If `$LAST_RELEASED_COMMIT` does not resolve (`git cat-file -e` fails), **stop and report** — that
means fork history was rewritten, which the merge-based sync is supposed to prevent. Do not guess a
replacement.

## 3. Decide whether there is anything to release

Release if **either** holds:

- there is at least one non-bot fork commit in the range, or
- `$ANCHOR` differs from `upstream_synced` (upstream shipped since the last release)

If neither holds, report "nothing to release" and stop.

Always report the upstream gap — e.g. *"main is 100 commits behind upstream/main"* — but never let
it block. It is informational; releases cut from main's actual content.

## 4. Compute the version

`release-cut.yml` takes the version in **two separate inputs**, so compute three values and keep
them distinct:

| Value | Meaning | Example |
|---|---|---|
| `VERSION_BASE` | passed as `-f version` — no fork identifier | `1.4.156-rc.1` |
| `VERSION_SUFFIX` | passed as `-f version_suffix` — the fork identifier alone | `zy01` |
| `TAG` | what release-cut actually creates, `v${VERSION_BASE}.${VERSION_SUFFIX}` | `v1.4.156-rc.1.zy01` |

`TAG` is never passed to the workflow — release-cut concatenates the two inputs. But it is the
value the changelog heading and every report must use.

Derive `VERSION_BASE` from the anchor, and `BASE` (the bare `X.Y.Z`) for the history lookup:

- **Anchor is an rc** (`v1.4.156-rc.1`) → `VERSION_BASE=1.4.156-rc.1`, `BASE=1.4.156`
- **Anchor is stable** (`v1.4.156`) → next patch at rc.0: `VERSION_BASE=1.4.157-rc.0`,
  `BASE=1.4.157`

  A stable anchor **must** re-enter rc shape. `1.4.157-zy01` sorts *below* `1.4.157-rc.0.zy01`
  because `rc` precedes `zy` alphabetically, which would regress the update channel.

Then check the gate:

```sh
HIGHEST=$(node config/scripts/release-rc-history.mjs "${BASE}")
```

If `$HIGHEST` is non-empty and ≥ `VERSION_BASE`'s rc number, rewrite `VERSION_BASE` to use
`rc.$((HIGHEST + 1))` — release-cut refuses an rc at or below the highest already cut for that
base. `release-rc-history.mjs` counts only `.zy`-suffixed releases, so upstream's inherited rc
history does not pin the gate.

`VERSION_SUFFIX` stays `zy01` unless `$TAG` already exists, in which case increment (`zy02`, …).
**Always zero-pad to at least two digits** — unpadded `zy10` sorts below `zy9`, and both
`create-draft-release.mjs` and `release-rc-history.mjs` reject the unpadded form outright.

Worked example — anchor `v1.4.156-rc.1`, no prior fork release:

```sh
VERSION_BASE=1.4.156-rc.1
VERSION_SUFFIX=zy01
TAG=v1.4.156-rc.1.zy01
```

Sanity-check `$TAG` before dispatching: it must be greater than the last released version, and less
than the anchor's next rc.

## 5. Write the changelog

Prepend a new section under `# Changelog`, newest first:

```markdown
## [1.4.156-rc.1.zy01] - 2026-07-27

Synced to upstream [v1.4.156-rc.1](https://github.com/stablyai/orca/releases/tag/v1.4.156-rc.1).

### Changed
- Release builds are now signed, notarized, macOS-only, and auto-update from this fork.
```

- Use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) groupings: `Added`, `Changed`,
  `Fixed`, `Removed`, `Deprecated`, `Security`.
- **Reword each commit into reader-facing prose.** Read the full commit body — squash-merged PRs
  carry detail the subject line throws away. Do not paste subjects verbatim.
- The heading must be exactly `$TAG` minus its leading `v` (here, `1.4.156-rc.1.zy01`);
  `create-draft-release.mjs` matches on it to build the release body. A mismatch silently drops
  the section and the release ships with generated notes only.
- With no fork commits, keep the section — the `Synced to upstream` line alone is the entry.

Then update the frontmatter:

- `last_released_commit` → the SHA of the changelog commit you are about to make (fill in after
  committing, then amend)
- `upstream_synced` → `$ANCHOR`

## 6. Confirm, commit, dispatch

Unless `--yes` was passed, show `$TAG`, the changelog diff, the upstream gap, and the commits
included, then ask for confirmation.

```sh
git add CHANGELOG.md
git commit -m "docs(changelog): release ${TAG}"
git commit --amend -m "docs(changelog): release ${TAG}"   # after writing the real SHA in
git push origin main

gh workflow run release-cut.yml \
  -f kind=rc \
  -f ref=main \
  -f version="${VERSION_BASE}" \
  -f version_suffix="${VERSION_SUFFIX}"
```

Pass `version` and `version_suffix` separately — never the joined `$TAG`, and never `$TAG` with a
leading `v`. `kind` is a required input; it is ignored when `version` is set, but must still be
passed.

Report the run URL:

```sh
gh run list --workflow=release-cut.yml --limit 1 --json url,status
```

## 7. Report

State the version cut, the commits included, the upstream anchor, the gap, and the run URL. If the
dispatch failed, say so plainly and leave the changelog commit in place — it is valid regardless.

## Notes

- **Never rewrite fork history.** The whole design depends on `last_released_commit` staying
  resolvable. The sync automation merges upstream rather than rebasing for this reason.
- Fork releases are always prereleases, so they reach only clients on the prerelease channel. That
  is intended — the fork tracks upstream RCs.
- A release with no signed macOS artifacts is useless for auto-update, which is why this skill
  dispatches `release-cut.yml` rather than calling `gh release create` directly.
