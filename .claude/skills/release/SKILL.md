---
name: release
description: Use when cutting a release of the zpyoung/orca fork, when a fork release failed or is stuck as a draft, or when asked to update CHANGELOG.md with fork-owned changes. Records commits this fork owns (not upstream's), computes a fork version anchored to the upstream point main is built on, dispatches release-cut.yml, and watches the build until the release is published, recovering the failures it can. Triggers on "cut a release", "release the fork", "release failed", "get the release out", "update the changelog", "ship a build".
---

# Releasing the fork

`zpyoung/orca` is a consumption fork of `stablyai/orca`. A release answers two questions:
**what did this fork change** (`CHANGELOG.md`) and **what upstream is it built on** (the version).

This skill writes the changelog, dispatches the existing release pipeline, and stays with the build
until the GitHub release is published. A dispatched cut is not a release: the tag and changelog
land minutes in, while signing, notarization, and publishing take over an hour and can fail on their
own, leaving a draft no client ever sees. It does **not** sync upstream, and it does **not** run
typecheck/lint/tests — CI owns verification.

Arguments: `--yes` skips the confirmation prompt and every other question (for unattended
automation runs). Where an unattended run would need a person, it stops and reports "needs
attention" instead.

## 1. Check preconditions

Stop and report if any fail. Do not write anything until every one of them passes.

```sh
git status --porcelain                 # must be empty
git fetch origin main
git fetch upstream
git rev-list --count origin/main..HEAD # must be: 0  (nothing unpushed)
git rev-list --count HEAD..origin/main # must be: 0  (nothing unpulled)
```

**Both** counts are required. `origin/main..HEAD` alone is also `0` when local `HEAD` is *behind*
`origin/main`, which would let the skill compute and commit against stale state and then fail the
push as non-fast-forward.

What this skill needs is a clean checkout whose content **is** `origin/main` — the two counts prove
exactly that, and they hold on a detached `HEAD` as readily as on the branch. Do not additionally
require `HEAD` to be the branch `main`: the sync automation runs in a per-run worktree and reaches
this skill detached at `origin/main`, because `main` is checked out in another worktree and git will
not hand the same branch to two of them.

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

### First, check that the previous release actually shipped

The frontmatter advances when the changelog commit lands, before the build runs. So a cut whose
build failed looks fully released to the range check below, and every later run would report
"nothing to release" while the newest fork release sits as a draft with no assets. This happened to
`v1.4.219-rc.0.zy01` and `v1.4.225-rc.0.zy01`. Check the newest changelog section's tag before
anything else:

```sh
PREV_TAG=v$(grep -m1 -oE '^## \[[^]]+\]' CHANGELOG.md | sed -E 's/^## \[(.*)\]$/\1/')
PREV_SHA=$(git log -1 --format=%H -F --grep="docs(changelog): release ${PREV_TAG}" HEAD)
gh release view "$PREV_TAG" --repo zpyoung/orca --json isDraft,assets \
  --jq '{isDraft, assets: [.assets[].name]}'
gh run list --repo zpyoung/orca --workflow=release-cut.yml --commit "$PREV_SHA" \
  --json databaseId,status,conclusion,createdAt,url --limit 1
```

A release-cut run's head SHA is the changelog commit it was dispatched on, which is why `--commit`
finds it.

- **Published** (`isDraft` false, assets present) → carry on below.
- **Run still in progress** → do not cut. Go to Step 7 and watch that run instead.
- **No run, and no tag** → "changelog pushed, dispatch never ran" (see *Recovering from a partial
  failure*). Re-dispatch the same version, then go to Step 7.
- **Run failed** → classify its failure with Step 7's table, then:
  - If the range check below finds something new to release, cut normally. The new cut supersedes
    the draft, and Step 5 carries the draft's entries forward.
  - Otherwise, for a **transient** or **account-side** cause, re-run the failed jobs
    (`gh run rerun "$RUN_ID" --repo zpyoung/orca --failed`) and go to Step 7. A re-run costs no
    suffix and needs no changelog change. GitHub refuses re-runs of runs older than 30 days; recut
    instead.
  - Otherwise, for a **repo defect**, apply Step 7's fix flow if `origin/main` doesn't already
    carry a fix, then recut with the suffix advanced. A re-run would replay the broken workflow,
    because re-runs use the run's original commit.

Only the newest section matters. Older drafts are already superseded; leave them alone.

### Then, check for new content

Release if **either** holds:

- there is at least one non-bot fork commit in the range, or
- `$ANCHOR` differs from `upstream_synced` (upstream shipped a new stable release since the last one)

If neither holds, and the previous release is published, report "nothing to release" and stop.

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
- When this cut supersedes an unpublished draft (Step 3), copy the draft section's entries into the
  new one, because no client ever received them. Then add one line under the draft's own heading:
  `Not published: the build failed. Superseded by <new version>.` Leave the rest of
  that section as it was.

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
git push origin HEAD:refs/heads/main

gh workflow run release-cut.yml \
  --repo zpyoung/orca \
  -f kind=rc \
  -f ref=main \
  -f version="${VERSION_BASE}" \
  -f version_suffix="${VERSION_SUFFIX}"
```

Push `HEAD`, not the branch name: the refspec form is correct whether the run is on `main` or
detached at it, and it still fast-forwards `origin/main` either way. A rejected push means
`origin/main` moved mid-run — report it, never force.

`--repo` is **not optional**. The clone has an `upstream` remote and no `gh repo set-default`, so a
bare `gh` command resolves to `stablyai/orca`, not the fork. The dispatch then fails `HTTP 403`
(the account has read-only access upstream), which reads as a credentials problem and sends you
debugging auth rather than the target. Read-only `gh` commands are worse — they succeed against the
wrong repo and return upstream's data as if it were the fork's, so `--repo` belongs on every `gh`
call here, not just the dispatch.

Pass `version` and `version_suffix` separately — never the joined `$TAG`, and never `$TAG` with a
leading `v`. `kind` is a required input; it is ignored when `version` is set, but must still be
passed.

Capture the run by the changelog commit it was dispatched on. It can take a few seconds to appear:

```sh
RELEASE_SHA=$(git rev-parse HEAD)
gh run list --repo zpyoung/orca --workflow=release-cut.yml --commit "$RELEASE_SHA" \
  --event workflow_dispatch --json databaseId,url,status --limit 1
```

Do not take `--limit 1` without `--commit`. A scheduled cut or another dispatch can be newer.

**`dry_run=true` cannot validate any of this.** Its `if:` condition also skips release-cut's
"Compute next version" step, so a dry run never evaluates the version gate, the rc/suffix history,
or the tag it would cut — it only echoes the schedule-window state, which a manual dispatch already
bypasses. There is no way to rehearse a cut; verify by reading the gate, then dispatch for real.

## 7. Watch the build until the release is published

Stay with the run. Mac signing and notarization alone take over an hour, so watch in the background
and expect to wait up to 3 hours:

```sh
gh run watch "$RUN_ID" --repo zpyoung/orca --exit-status --compact --interval 300 \
  > "${TMPDIR:-/tmp}/release-watch-$RUN_ID.log" 2>&1; echo "exit=$?"
```

Write the output to a file and read its tail, because `gh run watch` redraws on every interval.
In Claude Code, run the command with `run_in_background` and wait for the completion notification.
Don't poll it yourself.

**On success, confirm the release is really out:**

```sh
gh release view "$TAG" --repo zpyoung/orca --json isDraft,isPrerelease,assets \
  --jq '{isDraft, isPrerelease, assets: [.assets[].name]}'
```

It must be `isDraft: false` and `isPrerelease: true`, with `latest-mac.yml`, an `-arm64-mac.zip`,
and `orca-macos-arm64.dmg` among the assets. Auto-update reads `latest-mac.yml`, so a release without
it has not shipped, even when every job is green.

**On failure, find what broke:**

```sh
gh run view "$RUN_ID" --repo zpyoung/orca --json jobs --jq '.jobs[] | select(.conclusion=="failure")
  | "\(.databaseId) \(.name) \([.steps[] | select(.conclusion=="failure") | .name] | join(","))"'
gh api "repos/zpyoung/orca/actions/jobs/$JOB_ID/logs" | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -nE '##\[error\]|Error|⨯' | head -40
```

Read the first real error, not the last. A failed job skips everything after it, so the jobs that
show as skipped never ran and say nothing about the cause. Then classify it:

| Cause | Looks like | Action |
|---|---|---|
| **Transient** | runner lost or shut down, network timeouts, 5xx from GitHub or Apple, notarytool timing out | `gh run rerun "$RUN_ID" --repo zpyoung/orca --failed`, then watch again |
| **Account-side** | notarytool `HTTP status code: 403. A required agreement is missing or has expired`, a 401 or rejected Apple ID, an expired signing certificate, a credential secret that is missing or empty | Stop with "needs attention". Name the error and what the owner must do, such as "sign the updated agreement at developer.apple.com/account". Leave the draft as it is. The next run's Step 3 re-runs it, so no recut is needed once the owner fixes the account. |
| **Repo defect** | the same step fails the same way on a re-run: a workflow input the fork doesn't provide, an upstream workflow or script change that assumes upstream's setup, a fork-owned file that drifted | Fix it on `main` (below), then recut with the suffix advanced |

A re-run replays the run's original commit and workflow file, so it can only clear transient or
account-side causes. If the rerun fails the same way, treat the cause as a repo defect.

**Fixing a repo defect.** The fix goes through a PR, never a direct push:

1. Branch from `origin/main` as `release-fix/<tag>` and make the smallest change that makes the
   failing step pass on the fork. Files a fork must own to fix this are almost always the release
   workflows and `config/scripts/release-*`. Keep `config/fork-ownership.json` correct for anything
   you touch.
2. Never weaken a gate to get through: no skipped signing, notarization, or verification step, no
   loosened version gate, no `continue-on-error`. A placeholder value is acceptable only for an
   input the fork deliberately leaves unused, such as the telemetry key while
   `TELEMETRY_ENABLED` is false. Never put a real credential in a file.
3. Open the PR with `env -u GITHUB_TOKEN gh pr create --repo zpyoung/orca` and a body following
   `.github/pull_request_template.md`. Wait for its checks in the background, then merge with
   `env -u GITHUB_TOKEN gh pr merge <n> --repo zpyoung/orca --merge`. Never `--squash` or
   `--rebase`. PR CI never runs the release workflows, so green checks prove only that nothing else
   broke, and the recut is the real test.
4. Detach onto the new `origin/main`, then go back to Step 2 and recut. Step 3 finds the failed
   draft, and Step 5 carries its entries forward.

If the fix needs a judgement call, such as taking or dropping a fork feature, or a change outside
the release pipeline, or if its PR doesn't go green within 2 hours, leave the PR open and report
"needs attention".

**Limits per invocation:** at most one re-run per cut, one fix PR, and two cuts in total, the
original and one recut. When a limit is hit, stop and report "needs attention" with the run URL
and the classified cause. Never loop on recuts. Each recut spends a `zyNN` suffix, and there are
only 99.

## 8. Report

State the outcome first: `published <TAG>` with the release URL, or `needs attention` with the
cause, its classification, and what a person must do. Then list the version cut, the commits
included, the upstream anchor, the gap, every run URL, any re-run or recut and its reason, and any
fix PR.

## Recovering from a partial failure

The changelog commit lands before the dispatch, so the two can disagree. Diagnose by comparing
`CHANGELOG.md`'s newest section against the tags that actually exist.

**Changelog pushed, dispatch never ran** (`gh workflow run` failed, or you declined at the prompt).
The frontmatter already advanced, so a naive re-run sees nothing to release. Re-dispatch the *same*
`VERSION_BASE`/`VERSION_SUFFIX` by hand — the changelog section is still correct and `$TAG` does not
exist yet. Do not write a second changelog section.

**Tag created, build failed with an incomplete draft.** Step 3 finds it and Step 7 decides between a
re-run of the failed jobs and a recut. Never reuse the tag for a fresh dispatch. A recut advances
the suffix (`rc.1.zy01` → `rc.1.zy02`), which the gate admits, and adds a new changelog section for
the new tag. Note `kind=rc` recovery cannot help here: `release-cut.yml` reconstructs a *bare*
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
