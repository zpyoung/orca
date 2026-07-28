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
git rev-list --count origin/main..HEAD # must be: 0  (nothing unpushed)
git rev-list --count HEAD..origin/main # must be: 0  (nothing unpulled)
```

**Both** counts are required. `origin/main..HEAD` alone is also `0` when local `main` is *behind*
`origin/main`, which would let the skill compute and commit against stale state and then fail the
push as non-fast-forward.

## 2. Resolve the release inputs

```sh
ANCHOR=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-rc*' --exclude '*.zy*' HEAD)
GAP=$(git rev-list --count HEAD..upstream/main)
```

The anchor is the newest upstream **stable** tag reachable from `HEAD` — the release the sync
automation last merged. Do not compute it from `git merge-base upstream/main HEAD`. Upstream cuts
its stable tags on release branches rather than on `main`, and those branches carry no trunk commits
of their own, so merging one never advances the merge base. Since the sync no longer merges
`upstream/main` at all, that merge base freezes at the last trunk commit the fork absorbed and the
anchor is stuck there forever — reporting the same rc while the fork ships v1.4.161, v1.4.162, and
onward. Both `--exclude`s matter too: upstream rc tags and the fork's own `…-rc.N.zyNN` tags are all
reachable from `HEAD` and would otherwise win.

If `git describe` finds no match, **stop and report**: it means no upstream stable release has been
merged yet. Do not fall back to an rc tag.

Read `last_released_commit` and `upstream_synced` from `CHANGELOG.md`'s YAML frontmatter, then
list candidate commits:

```sh
git log --no-merges --format='%H%x09%an%x09%s' "$LAST_RELEASED_COMMIT"..HEAD ^upstream/main ^"$ANCHOR"
```

Both exclusions are **not optional**. `--no-merges` drops merge *commits*, not the upstream commits
a merge brings in — since the sync merges rather than rebases, every upstream commit absorbed since
the last release is reachable from `HEAD` and would otherwise appear here. Without the exclusions
this range returns upstream's work and the changelog would describe it as the fork's.

`^upstream/main` alone is not enough. The sync merges a release-branch tag, and upstream builds that
branch by cherry-picking fixes onto it — so those commits carry release-branch SHAs that are *not*
reachable from `upstream/main`. They are real-authored, so the bot filter below does not catch them
either. `^"$ANCHOR"` is what excludes them.

Then **exclude** two more classes from what remains:

- **Bot-authored commits** — any author containing `[bot]`. Drops the recurring
  `Update README downloads badge` commit and release-cut's own version-bump commit.
- **The skill's own changelog commits** — subject starting `docs(changelog): release`. The previous
  release's changelog commit is fork-owned and sits inside this range by construction.

What remains is the set of fork commits needing changelog entries.

If `$LAST_RELEASED_COMMIT` does not resolve (`git cat-file -e` fails), **stop and report** — that
means fork history was rewritten, which the merge-based sync is supposed to prevent. Do not guess a
replacement.

## 3. Decide whether there is anything to release

Release if **either** holds:

- there is at least one non-bot fork commit in the range, or
- `$ANCHOR` differs from `upstream_synced` (upstream shipped a new stable release since the last one)

If neither holds, report "nothing to release" and stop.

Always report the upstream gap — e.g. *"main is 100 commits behind upstream/main"* — but never let
it block. It is informational; releases cut from main's actual content. Expect this number to stay
large and to grow between upstream stable releases: the sync deliberately tracks stable tags, so
everything upstream has landed on `main` since the last stable cut is unmerged by design.

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

  A stable anchor **must** re-enter rc shape, but not for the reason symmetry suggests.
  `1.4.157-zy01` actually sorts *above* `1.4.157-rc.0.zy01` (comparing `zy01` against `rc`, and
  `rc` < `zy01` as strings). That is precisely the problem: cut `1.4.157-zy01` now and the next
  anchor `v1.4.157-rc.0` would force `1.4.157-rc.0.zy01`, which sorts **below** it — a regression.
  Staying in rc shape keeps the series ordered.

**The rc position names the upstream anchor and must never be inflated to dodge the gate.**
Repeat cuts on one anchor advance `VERSION_SUFFIX`, not the rc:

```sh
RC=${VERSION_BASE#*-rc.}                                                  # e.g. 1
HIGHEST_SUFFIX=$(node config/scripts/release-rc-history.mjs "${BASE}" --rc "${RC}")
```

- `$HIGHEST_SUFFIX` empty → `VERSION_SUFFIX=zy01`
- otherwise → `VERSION_SUFFIX=zy$(printf '%02d' $((HIGHEST_SUFFIX + 1)))`

`release-cut.yml` admits an rc equal to the highest already cut as long as the `zyNN` suffix
strictly advances, so `rc.1.zy01` → `rc.1.zy02` is the correct second cut — **not** `rc.2.zy01`,
which would claim an upstream anchor the build was never cut from. `release-rc-history.mjs` counts
only `.zy`-suffixed releases, so upstream's inherited rc history never pins the gate.

**The counter is exactly two digits, `zy01`–`zy99`.** `zyNN` is a single alphanumeric semver
identifier compared as a string, so only a fixed width keeps string order and numeric order in
agreement — `zy1` sorts above `zy01`, and `zy100` below `zy99`. Both scripts reject any other
width. If a base+rc ever reaches `zy99`, stop and report rather than rolling over.

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

```sh
RELEASED_THROUGH=$(git rev-parse HEAD)   # BEFORE committing the changelog
```

- `last_released_commit` → `$RELEASED_THROUGH`, i.e. current `HEAD` **before** the changelog commit
  exists — the last fork commit covered by this release
- `upstream_synced` → `$ANCHOR`

**Never** set `last_released_commit` to the changelog commit's own SHA. A commit cannot contain its
own hash: writing the SHA and then amending changes it, leaving a value that points at a commit no
longer on `main` and that will not resolve in a fresh clone. The next run would then hard-stop at
step 2. Using the pre-commit `HEAD` is self-consistent, which is why step 2 also excludes
`docs(changelog): release` commits — the changelog commit falls inside the next range by design.

## 6. Confirm, commit, dispatch

Unless `--yes` was passed, show `$TAG`, the changelog diff, the upstream gap, and the commits
included, then ask for confirmation.

```sh
git add CHANGELOG.md
git commit -m "docs(changelog): release ${TAG}"
git push origin main

gh workflow run release-cut.yml \
  --repo zpyoung/orca \
  -f kind=rc \
  -f ref=main \
  -f version="${VERSION_BASE}" \
  -f version_suffix="${VERSION_SUFFIX}"
```

`--repo` is **not optional**. The clone has an `upstream` remote and no `gh repo set-default`, so a
bare `gh` command resolves to `stablyai/orca`, not the fork. The dispatch then fails `HTTP 403`
(the account has read-only access upstream), which reads as a credentials problem and sends you
debugging auth rather than the target. Read-only `gh` commands are worse — they succeed against the
wrong repo and return upstream's data as if it were the fork's, so `--repo` belongs on every `gh`
call here, not just the dispatch.

Pass `version` and `version_suffix` separately — never the joined `$TAG`, and never `$TAG` with a
leading `v`. `kind` is a required input; it is ignored when `version` is set, but must still be
passed.

Report the run URL:

```sh
gh run list --repo zpyoung/orca --workflow=release-cut.yml --limit 1 --json url,status
```

**`dry_run=true` cannot validate any of this.** Its `if:` condition also skips release-cut's
"Compute next version" step, so a dry run never evaluates the version gate, the rc/suffix history,
or the tag it would cut — it only echoes the schedule-window state, which a manual dispatch already
bypasses. There is no way to rehearse a cut; verify by reading the gate, then dispatch for real.

## 7. Report

State the version cut, the commits included, the upstream anchor, the gap, and the run URL.

## Recovering from a partial failure

The changelog commit lands before the dispatch, so the two can disagree. Diagnose by comparing
`CHANGELOG.md`'s newest section against the tags that actually exist.

**Changelog pushed, dispatch never ran** (`gh workflow run` failed, or you declined at the prompt).
The frontmatter already advanced, so a naive re-run sees nothing to release. Re-dispatch the *same*
`VERSION_BASE`/`VERSION_SUFFIX` by hand — the changelog section is still correct and `$TAG` does not
exist yet. Do not write a second changelog section.

**Tag created, build failed with an incomplete draft.** Do not reuse the tag. Cut again with the
suffix advanced (`rc.1.zy01` → `rc.1.zy02`), which the gate admits, and add a new changelog section
for the new tag. Note `kind=rc` recovery cannot help here: `release-cut.yml` reconstructs a *bare*
`v<base>-rc.<n>` tag, which never matches a `.zy` tag.

**Never delete a published tag or release to retry.** The suffix history is read from tags *and*
`release:` commit subjects precisely so a deleted tag still counts; deleting one only removes the
tag, not the record, and clients may already have installed it.

## Never cut a bare fork release

Every fork release must carry a `zyNN` suffix. Fork history is tracked by that suffix alone, so a
bare `version=X.Y.Z-rc.N` dispatch with no `version_suffix` would be untracked — yet still
installable, since the prerelease feed excludes only `perf` identifiers. A later `.zy` cut at a
lower rc would then sort beneath it and strand anyone who installed it. `release-cut.yml` refuses
this once a fork series exists for the base, but do not rely on that as the only guard.

## Notes

- **Never rewrite fork history.** The whole design depends on `last_released_commit` staying
  resolvable. The sync automation merges upstream rather than rebasing for this reason.
- Fork releases are always prereleases, so they reach only clients on the prerelease channel. That
  is intended — the fork tracks upstream RCs.
- A release with no signed macOS artifacts is useless for auto-update, which is why this skill
  dispatches `release-cut.yml` rather than calling `gh release create` directly.
