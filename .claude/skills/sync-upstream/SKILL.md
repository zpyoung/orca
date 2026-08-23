---
name: sync-upstream
description: Use when syncing the zpyoung/orca fork to upstream's latest stable release, or when a sync has failed and needs diagnosing — merges an upstream stable tag into main, resolves file ownership from the manifest, verifies, pushes, and hands off to the release skill. Triggers on "sync upstream", "sync the fork", "merge the stable tag", "sync failed", "typecheck fails after the merge".
---

# Syncing the fork with upstream

`zpyoung/orca` is a consumption fork of `stablyai/orca`. A sync merges upstream's latest **stable
release tag** into `origin/main`, resolves every file to its declared owner, proves the result still
builds, and pushes only after a remote backup exists and verification passes. Then, if the sync
landed cleanly and there is anything to release, it cuts a fork release.

This skill owns the procedure end to end. Two halves are delegated and must not be re-implemented
here:

- **Ownership resolution and verification** — [`references/file-ownership.md`](./references/file-ownership.md)
- **Releasing** — the `release` skill

Arguments: `--unattended` suppresses every confirmation prompt. It does **not** grant extra
latitude: an unattended run stops and reports wherever an attended run would ask a human, and the
decisions this skill routes to a human stay routed to a human.

## Two invariants, both counter-intuitive

**Stable tags, never `upstream/main`.** Upstream lands work on `main` continuously and cuts `-rc.N`
prereleases from it, so `upstream/main` is unreleased code at any moment. This fork consumes
releases, so it syncs only what upstream has actually shipped as stable.

Two consequences to not get wrong:

- **Stable tags do not live on `main`.** Upstream cuts a release branch at the matching
  `vX.Y.Z-rc.0` commit, cherry-picks fixes onto it, and tags `vX.Y.Z` there. That tag commit is not
  an ancestor of `upstream/main`. You cannot obtain the stable release by picking a commit off
  `main` — you must merge the tag itself.
- **No new stable release means do nothing.** Never substitute the newest `-rc.N`, never fall back
  to `upstream/main`, and never sync "just the trunk commits" to keep things moving. A day with no
  new stable release is a successful no-op.

**Merge, never rebase.** A rebase replays fork commits onto the new upstream tip, minting new SHAs
every sync. Two things depend on fork commit SHAs being permanent: `CHANGELOG.md` frontmatter
records `last_released_commit`, and a rewritten SHA makes it dangle so the release skill hard-stops;
and release tags on fork commits become unreachable from `main` after a rebase, so published
releases point into a dead lineage. Merging keeps every fork commit at its original SHA forever and
keeps `main` append-only.

**Git semantics here are inverted from a rebase.** During `git merge $UPSTREAM_TARGET` with `main`
checked out, `ours` is the fork's `main` and `theirs` is upstream. Favoring the fork therefore means
`-X ours` and `git checkout --ours`, never `-X theirs`.

`-X ours` is only the first pass, and on its own it produces a tree that does not compile. Step 6 is
not optional — a merge that skips it fails Step 8 every time, and re-running unchanged fails
identically.

## Step 1 — Remotes, fetch, and resolve the stable target

Run `git remote get-url upstream`. If missing, add it:
`git remote add upstream git@github.com:stablyai/orca.git`. If it exists but points anywhere other
than stablyai/orca, STOP and report.

Fetch: `git fetch upstream main` then `git fetch origin main upstream`.

Resolve upstream's latest stable release tag from the **remote**, never from local tags — the fork's
own release tags (`vX.Y.Z-rc.N.zyNN`) live in the local tag namespace and must never be mistaken for
an upstream release:

```sh
STABLE_TAG=$(git ls-remote --tags --refs --sort=v:refname upstream 'refs/tags/v*' \
  | sed 's|.*refs/tags/||' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | tail -1)
```

The `grep -E` anchors on both ends, which is what excludes every prerelease: `-rc.N` tags and fork
`.zyNN` tags both fail it. Filtering to strict `vX.Y.Z` before sorting also makes `--sort=v:refname`
unambiguous, since no suffixes remain to order.

`git ls-remote` can exit non-zero after printing a partial list, and `tail -1` will then hand you a
stale tag as though it were the newest. Check the exit code and the ref count before trusting the
result; a dropped connection is a retry, not a target.

If `$STABLE_TAG` is empty or does not match `^v[0-9]+\.[0-9]+\.[0-9]+$`, STOP and report "needs
attention: could not resolve an upstream stable release tag". Do not guess, and do not proceed with
an rc.

Fetch that one tag by explicit refspec and resolve it to a commit:

```sh
git fetch upstream "refs/tags/${STABLE_TAG}:refs/tags/${STABLE_TAG}"
UPSTREAM_TARGET=$(git rev-parse "${STABLE_TAG}^{commit}")
```

Fetch before resolving, always. `ls-remote` names commits the fork has never downloaded, and any
`git` command given one of those SHAs — `merge-base --is-ancestor` especially — exits 128 and aborts
mid-run. Upstream tags are immutable, so a rejected non-fast-forward tag update means something is
wrong: STOP and report rather than forcing it.

Capture these and keep them; every restore path depends on them:

```sh
ORIGIN_MAIN_OLD=$(git rev-parse origin/main)
UPSTREAM_MAIN=$(git rev-parse upstream/main)
ORIGIN_UPSTREAM_OLD=$(git rev-parse origin/upstream)
```

`$UPSTREAM_MAIN` is needed for the mirror branch in Step 10, the fork-commit range in Step 2, and
the informational gap in Step 13. It is never the merge target.

## Step 2 — Assess

List the fork-specific commits:

```sh
git log --oneline --no-merges origin/main --not upstream/main "$UPSTREAM_TARGET"
```

Call this set FORK_COMMITS; record its count N and the exact SHAs.

Both exclusions are required. `--no-merges` matters because earlier sync merge commits live in that
range and are not fork work. Excluding `upstream/main` as well as `$UPSTREAM_TARGET` matters because
`main` already contains upstream trunk commits absorbed by previous syncs; a plain
`$UPSTREAM_TARGET..origin/main` range reports those as fork work and inflates N by dozens.

- If `git merge-base --is-ancestor "$UPSTREAM_TARGET" origin/main` succeeds, `main` already contains
  this release. Skip to Step 10 and note "no new stable release (already at $STABLE_TAG)". This is
  the expected outcome on most days and is a success, not a warning.
- If N is 0 and `git merge-base --is-ancestor origin/main "$UPSTREAM_TARGET"` succeeds, this is a
  plain fast-forward. Push `git push origin "${UPSTREAM_TARGET}:refs/heads/main"`, skip to Step 10,
  and note "fast-forward, no merge needed".
- Otherwise continue.

## Step 3 — Backup

Build a UTC stamp for the run (`date -u +%Y%m%d-%H%M%SZ`, or the PowerShell equivalent on Windows)
and set `BACKUP_REF=backup/main-<stamp>`. Push the current `origin/main` to that new branch — a
brand-new ref, so no force is involved:

```sh
git push origin "${ORIGIN_MAIN_OLD}:refs/heads/${BACKUP_REF}"
```

Brace those variables exactly as written. Under zsh an unbraced `$VAR:refs/...` is parsed as the `:r`
history modifier, and the refspec is silently mangled to `<sha>efs/heads/...`, which fails as "src
refspec does not match any".

Also tag it locally: `git tag sync-backup/main-<stamp> $ORIGIN_MAIN_OLD`. The tag can succeed while
the push fails, so a previous failed run may have left a local `sync-backup/*` tag with no remote
branch — reuse that stamp rather than minting a new one.

Then PROVE the remote backup landed: `git ls-remote origin "refs/heads/${BACKUP_REF}"` must print
`$ORIGIN_MAIN_OLD`. If it does not, STOP — do not merge, do not push anything. Report "needs
attention: backup push failed, aborted before touching main".

## Step 4 — Choose where to merge

Full verification needs the existing `node_modules`, so it can only run in this checkout.

**Path A (verified, can push).** Requires all of: `main` is the current branch
(`git symbolic-ref --short HEAD` is `main`), `git status --porcelain` is empty, and no
rebase/merge/cherry-pick is in progress (no `.git/rebase-merge`, `.git/rebase-apply`,
`.git/MERGE_HEAD`). Reset local main onto the fetched remote state first:
`git reset --hard $ORIGIN_MAIN_OLD`. Merge in place on `main`.

**Path B (probe only, never pushes).** Any Path A condition fails. Do not touch this checkout.
Create a scratch worktree — `git worktree add <tmpdir>/sync-probe -b __sync_probe $ORIGIN_MAIN_OLD`
— and do Steps 5 and 6 there to learn whether resolution is even possible. Verification is
unavailable, so main is not pushed regardless of outcome. Always clean up:
`git worktree remove --force <tmpdir>/sync-probe` and `git branch -D __sync_probe`. Report "needs
attention: workspace busy (dirty tree / branch <X> checked out), merge probe result:
<clean | auto-resolvable | conflicted>, main not pushed".

## Step 5 — Merge with fork priority

Record the pre-merge fork tip first. Step 6 needs it, and it is unrecoverable once the merge
advances `HEAD`:

```sh
MERGE_HEAD_PRE=$(git rev-parse HEAD)
```

Attempt 1, no auto-resolution: `git merge --no-edit "$UPSTREAM_TARGET"`. If it completes with no
conflicts, record `resolution=clean` and go to Step 6.

If it stops on conflicts, `git merge --abort` and try Attempt 2, favoring the fork on every
conflicting hunk:

```sh
git merge --no-edit -X ours "$UPSTREAM_TARGET"
```

Record `resolution=auto-ours` if it completes. `-X ours` silently discards the upstream side of each
conflicting hunk — that is the intent, and it is exactly why Steps 6 and 8 are non-negotiable.

Expect `package.json`'s `version` field to conflict on most runs: the release branch carries
upstream's `release: vX.Y.Z` bump while `main` carries the fork's `X.Y.Z-rc.N.zyNN`. `-X ours`
keeping the fork's version is correct — the fork owns its own version line.

`-X ours` does not resolve tree-level conflicts, so the merge may still stop. Only these two are
auto-resolvable, and only in the fork's favor:

- **"deleted by them / modified by us"** (upstream deleted it, the fork modified it) → keep the
  fork's file: `git checkout --ours -- <path>` then `git add <path>`.
- **"deleted by us / modified by them"** (the fork deleted it, upstream modified it) → honor the
  fork's deletion: `git rm -f <path>`.

Then `git commit --no-edit`. Record `resolution=auto-ours+tree` and log every path touched with the
rule applied.

Anything else — rename/rename, rename/delete, submodule conflicts, binary files you cannot attribute
to a side, or more than 25 conflicted paths in total — is out of scope. Do not guess. Run
`git merge --abort` and go to Step 11 with "needs attention: merge conflicts require manual
resolution (<conflict type> at <paths>)".

After any completed merge, verify no conflict markers survived:
`git grep -nE '^(<{7}|={7}|>{7})( |$)' -- . | head -50` must be empty. If it is not, treat it as an
unresolvable failure.

## Step 6 — Resolve file ownership (REQUIRED after any merge)

Read [`references/file-ownership.md`](./references/file-ownership.md) and follow it. It owns the
policy and the exact commands; do not reconstruct them from memory here.

In short: ownership is **declared, not inferred** — `config/fork-ownership.json`, read through
`config/scripts/fork-ownership-manifest.mjs`, is the source of truth. Earlier syncs pulled in
upstream commits that only ever existed on a release branch, upstream's `main` has since reworked
that same code, and `-X ours` defends the stale copy while taking upstream's new code around it. The
manifest is what resolves each path back to its real owner.

Pass `$MERGE_HEAD_PRE` from Step 5 as the classifier's merge-head argument, and consume **all four**
output lists — `checkout.txt`, `remove.txt`, `ours.txt`, `merge-review.txt`. `merge-review.txt` has
no shell command: those paths took a real three-way merge and must be read by hand against the
manifest's declared lines.

The reference also carries three per-sync checklists that are part of this step, not optional
extras: **tier-2 forked-copy replay**, **tier-4 pending-upstream review**, and **upstream
feature-collision review**. Each can surface a decision the reference routes to a human. Under
`--unattended`, that is a stopping condition: go to Step 11 with "needs attention: <the decision>"
rather than choosing a side.

Commit the ownership resolution as a single follow-up commit on top of the merge; Step 7 expects
exactly one such extra commit.

If the classifier fails, or `checkout.txt` is empty when the merge was not a no-op, STOP and go to
Step 11 with "needs attention: ownership resolution failed". Do not fall back to plain `-X ours` —
that is the known-broken state.

## Step 7 — Commit accounting

Merging never replays fork commits, so unlike a rebase it cannot silently drop or rewrite them. That
makes this check strict and cheap: every SHA in FORK_COMMITS must still be present and reachable.

For each SHA recorded in Step 2, `git merge-base --is-ancestor <sha> HEAD` must succeed. If any does
not, something rewrote history — reset back (`git reset --hard $ORIGIN_MAIN_OLD` on Path A) and go to
Step 11 with "needs attention: fork commit <sha> <subject> is no longer reachable after merge".

Also re-run the Step 2 range against the merged head —
`git log --oneline --no-merges HEAD --not upstream/main "$UPSTREAM_TARGET"` — and confirm the count
is still N. A count above N is fine only if the extras are the merge resolution and the Step 6
ownership commit; a count below N is a hard failure.

## Step 8 — Verification gate (Path A only)

Run the gate exactly as [`references/file-ownership.md`](./references/file-ownership.md) § Verifying
specifies — including the manifest checks (`--verify-seams`, `--verify-residuals`), clearing
`config/*.tsbuildinfo` before every typecheck, and building the CLI plus neutralizing inherited Git
configuration before `pnpm test`. Those are not hygiene; each one deterministically fakes a result
if skipped.

Order: `pnpm install --frozen-lockfile` (upstream may have changed dependencies) → manifest checks →
`pnpm typecheck` → `pnpm lint` → `pnpm test`.

Everything up to and including `pnpm lint` is absolute: stop at the first failure and treat it as a
hard fail. The baseline differential below never applies to them. The reference's rule-tightening
carve-out is the one exception, and it is an exception about *how the tree is fixed*, not about
tolerating a failure — lint must still pass before the push, and the mechanical `oxlint --fix` it
permits is committed separately from the merge and the ownership commit.

`pnpm test` is baseline-differential. A test that already fails on the pre-merge fork tree is not
evidence the resolution broke anything — some tests are coupled to the machine (PATH, toolchain
versions, locale) rather than to the code. Only a test the merge **newly** breaks is a gate failure.
This suite also has genuinely nondeterministic failures that differ run to run, so re-run a lone
failure before treating it as signal.

If `pnpm test` fails:

1. Parse the failing test FILE paths and test NAMES from the vitest output. If more than 10 distinct
   files fail, skip the differential and treat it as a hard fail — breakage that broad is not an
   environment quirk.
2. Record the merged head: `MERGED_HEAD=$(git rev-parse HEAD)`.
3. Switch to the pre-merge baseline, which preserves the untracked `node_modules`:
   `git checkout --detach $ORIGIN_MAIN_OLD`. Then, only if
   `git diff --quiet $ORIGIN_MAIN_OLD $MERGED_HEAD -- pnpm-lock.yaml` reports a difference, run
   `pnpm install --frozen-lockfile` so the baseline runs against its own dependency set.
4. Re-run only the failing files at the baseline, with the same CLI build and Git-config scrubbing
   the reference specifies. A file that does not exist at the baseline (newly added by upstream)
   counts as "did not fail there".
5. Return to the merged tree: `git checkout main` (main is at `$MERGED_HEAD`). If you re-installed
   in (3), run `pnpm install --frozen-lockfile` again. Do this even if the differential errored
   partway — never leave the checkout detached.
6. Classify at test-name granularity, not file granularity:
   - Every failing test name also fails at the baseline → all pre-existing. The gate PASSES.
     Continue to Step 9 and report each tolerated failure as "pre-existing (also fails at
     $ORIGIN_MAIN_OLD)".
   - Any test name that passes at the baseline but fails after the merge → REGRESSION introduced by
     the resolution. Hard fail. This includes a file that fails on both sides but whose set of
     failing test names GREW after the merge.

On any hard fail, restore and bail: `git reset --hard $ORIGIN_MAIN_OLD`, then go to Step 11 with
"needs attention: merge resolved but <install|manifest|typecheck|lint|tests> failed — manual
resolution required; backup at origin/<BACKUP_REF>". Include the first ~20 lines of the failure
output, and for a test regression name the specific tests that pass at the baseline but fail after.

Do not push a tree that failed this gate, and do not "fix" failures in the fork's own code — that is
out of scope for a sync. The two exceptions are the upstream-defect case and the lint-tightening
case, both defined in the reference, and both require proving the cause before acting.

## Step 9 — Push main (Path A only, gate passed)

The merge only adds commits, so this is a fast-forward for the remote and needs no force:

```sh
git push origin main:refs/heads/main
```

NEVER use `--force` or `--force-with-lease` here. A rejected push means someone pushed to the fork
mid-run; the correct response is to report, not to overwrite. Report "needs attention: origin/main
moved during sync, push rejected — re-run to merge on top of the new tip" and leave local main as
merged (the backup still protects the old state).

## Step 10 — Update the fork's `upstream` mirror branch

The mirror branch tracks upstream's **trunk**, deliberately — it is a read-only convenience copy of
`upstream/main`, not a record of what was synced. Do not repoint it at `$STABLE_TAG`.

If `git merge-base --is-ancestor origin/upstream upstream/main` succeeds, fast-forward it:
`git push origin upstream/main:refs/heads/upstream`. Otherwise it has diverged — do NOT force.
Record "needs attention: upstream mirror branch diverged".

## Step 11 — Prune old backups

List `git ls-remote --heads origin 'refs/heads/backup/main-*'`. If more than 10 exist, delete the
oldest by stamp so 10 remain: `git push origin --delete refs/heads/backup/main-<stamp>`. Only ever
delete refs matching that exact pattern, and never the backup created by this run.

## Step 12 — Cut a release

Run this step only if ALL of the following hold. If any fails, skip it and record in Step 13 that no
release was attempted, with the reason.

- No hard fail occurred in Steps 3–9: the backup landed, no unresolvable conflict, commit accounting
  passed, the verification gate passed, and the push to `origin/main` succeeded. A Step 10
  mirror-branch warning does NOT block a release — it does not touch `main`.
- If a merge happened at all, Step 4 chose **Path A**. Path B never cuts: it could not verify and it
  never pushed. The Step 2 "no new stable release" short-circuit is fine to release from, since
  `main` was never modified.
- `main` is the current branch, `git status --porcelain` is empty, no probe worktree or
  `__sync_probe` branch remains, and — after `git fetch origin main` — `git rev-parse main` equals
  `git rev-parse origin/main`.

Do NOT decide for yourself whether there is anything worth releasing, and do not compute a version,
write `CHANGELOG.md`, tag, or dispatch a workflow by hand. Invoke the `release` skill:

```
Skill(release, args="--yes")
```

That skill owns the whole decision and already implements the rule this step wants — it releases
when there is at least one non-bot fork commit since `last_released_commit`, or when the upstream
anchor has moved since `upstream_synced`. Duplicating any of that here would drift from it. Pass
`--yes` only on an unattended run; attended, let it prompt.

"Nothing to release" is a normal, successful outcome, not a warning.

Dispatch only — do NOT wait for the build. `release-cut.yml` tags, builds, and publishes; mac
notarization alone runs over an hour. Record the dispatched run and stop.

If the release skill stops on one of its own preconditions or fails partway, that is a "needs
attention" item, but it does NOT invalidate the sync: `main` is already merged and pushed, and that
push stands. Never try to undo the sync because a release failed, and never re-run the skill in the
same run to force a different outcome.

## Step 13 — Report

- Stable target: `$STABLE_TAG` at `$UPSTREAM_TARGET`
- `origin/main`: old SHA → new SHA, and the resolution used (`no new stable release` |
  `fast-forward` | `clean` | `auto-ours` | `auto-ours+tree` | `not changed`)
- `origin/upstream`: old SHA → new SHA
- Backup ref: `origin/$BACKUP_REF` at `$ORIGIN_MAIN_OLD`
- Fork commits: N, all confirmed still reachable at their original SHAs
- Every path resolved against the manifest, grouped by the list it came from, plus every
  `merge-review.txt` path and what the hand review concluded
- Unreleased upstream work deliberately NOT taken: `git rev-list --count HEAD..upstream/main`.
  Expected to be large; informational only — it is the whole point of tracking stable releases.
- Verification: pass/fail per step, plus any test failures tolerated as pre-existing and the baseline
  SHA they were proven against
- Release: `nothing to release` | `skipped (<reason>)` | the tag cut and the run dispatched
- All "needs attention" items

## Hard safety rules

- The sync target is ALWAYS a strict `vX.Y.Z` upstream tag. Never merge an `-rc.N` tag, never merge
  `upstream/main`, never merge a commit picked off `main` as a stand-in for a release. If no new
  stable release exists, the correct action is to change nothing.
- Never rewrite `origin/main`. This flow is append-only: merge commits go on top, fork commit SHAs
  never change. Any operation that would rewrite fork history (rebase, filter-branch, amend of an
  existing fork commit) is out of scope.
- Never force-push anything — not `origin/main`, not `origin/upstream`, not any `backup/*` ref.
  There is no force-push in this flow at all.
- Conflict auto-resolution favors the fork only for files the manifest declares. `-X ours` during
  the merge, then Step 6 resolves everything else back to `$UPSTREAM_TARGET`. Tree conflicts are
  limited to the two cases in Step 5. Never hand-edit a conflicted file to invent a merge.
- A fork commit unreachable after the merge is a hard failure, never a warning to push through.
- A failing test may be tolerated ONLY by the Step 8 baseline differential, which requires
  reproducing the identical failure at `$ORIGIN_MAIN_OLD`. Never tolerate a failure because it looks
  environmental, sits in a known-flaky file, or seems unrelated to the diff.
- On any abort path, leave the repo exactly as found: no in-progress merge (`git merge --abort`),
  local main back at `$ORIGIN_MAIN_OLD`, the original branch re-checked-out, and no scratch state
  (`__sync_probe` branch, probe worktree). Never leave the workspace on a different branch than it
  started on.
- Releasing is delegated to the `release` skill, always. Never compute a fork version, edit
  `CHANGELOG.md`, create a tag, or dispatch `release-cut.yml` directly — the skill owns the version
  algebra, and a hand-rolled version can regress the published series and break auto-update.
- Never cut a release from a tree this run could not verify and push. No Path B release, no release
  after any hard fail, no release with a dirty tree or with `main` out of sync with `origin/main`.
- One release per run, at most. If the skill reports "nothing to release", that is the end of it.
