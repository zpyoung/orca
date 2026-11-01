---
name: sync-upstream
description: Use when syncing the zpyoung/orca fork to upstream's latest stable release, or when a sync has failed and needs diagnosing — merges an upstream stable tag on a run branch, resolves file ownership from the manifest, verifies, opens a PR, drives it green, merges it, and hands off to the release skill. Triggers on "sync upstream", "sync the fork", "merge the stable tag", "sync failed", "typecheck fails after the merge".
---

# Syncing the fork with upstream

`zpyoung/orca` is a consumption fork of `stablyai/orca`. A sync merges upstream's latest **stable
release tag** into a run branch, resolves every file to its declared owner, proves the result still
builds, and opens a pull request against `main`. The run then drives that PR's checks green, merges
it, and — if there is anything to release — cuts a fork release.

**`main` is never pushed directly.** Every sync lands through a PR, so the fork ownership guard and
the rest of PR CI run on the resolution before it reaches `main`.

This skill owns the procedure end to end. Two halves are delegated and must not be re-implemented
here:

- **Ownership resolution and verification** — [`references/file-ownership.md`](./references/file-ownership.md)
- **Releasing** — the `release` skill

Earlier runs record what they learned in
[`references/sync-lessons.md`](./references/sync-lessons.md). Read it before Step 4. It is written by
previous runs of this exact procedure, and it exists so you do not spend the budget rediscovering a
wrong turn one of them already paid for.

Arguments: `--unattended` suppresses every confirmation prompt. It does **not** grant extra
latitude: the decisions this skill routes to a human stay routed to a human.

**Escalating a decision means asking and waiting, attended or not.** Put the decision to the human
through `orca ask` (load the `orca-ask` skill for the CLI), then wait up to 12 hours the way the next
paragraph says. On an
answer, continue as the human chose. On `declined`, `timed_out` or `unavailable`, stop and report
"needs attention: <the decision>" — that is the only path to a decision-shaped stop. Build each
option from what you have read, naming the files it touches and which local and remote callers
depend on them, never from a feature's name: v1.4.230's first relay ask offered to retire
`native-chat-relay` outright when its renderer half also served local chat, and an agent had to
catch it. Read the gating code before asking at all — a second ask that run was withdrawn after one
`rg` showed the new store was dark by default.

**A run ends only at Step 16, and so does its turn.** Never end the turn, schedule a wakeup, or hand
back to the human before then, whether or not a PR is open. In an Orca automation run, ending the
turn reports the agent `done`: `createAutomationDispatchCompletion` marks the run completed and sleeps
its workspace, and every background command and subagent dies with exit 144. The runs of 2026-10-28,
10-29 and 10-30 each ended a turn "waiting on background agents" and died 9s, 3s and 74s later, and
the next day's run redid their work. The 2026-10-16 run ended its turn behind a background poll; its
green PR #120 then sat unmerged for 68 hours while the next three daily runs stopped behind it.

**So every wait is a bounded foreground command, repeated until it resolves:** a loop around
`orca ask wait --id <id> --json` that returns after about nine minutes, and `wait-pr-checks.mjs` with
`--timeout-minutes 9`. Foreground Bash tops out at ten minutes. Completion notifications from
background commands and subagents don't arrive during these calls, so check on that work between
waits: a subagent's report is the last assistant text in
`~/.claude/projects/<slug>/<session>/subagents/agent-*.jsonl`. Snapshot dirty work to a tag as you go,
so a kill can't lose it.

The run needs a disposable branch in a workspace of its own; the scheduled automation supplies one by
creating a fresh worktree per run. This skill never creates, renames, or deletes a branch or a
worktree — it verifies the one it was handed (Step 4) and works there.

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

Fetch both trunks by explicit refspec:

```sh
git fetch upstream "refs/heads/main:refs/remotes/upstream/main"
git fetch origin "refs/heads/main:refs/remotes/origin/main" "refs/heads/upstream:refs/remotes/origin/upstream"
```

A bare `git fetch upstream main` updates only `FETCH_HEAD` whenever `remote.<name>.fetch` does not
map `main`, and this clone's `upstream` refspec is narrowed to one branch pattern. `upstream/main`
then stays wherever it last was, which silently skews every `--not upstream/main` count below and
turns Step 12 into a no-op. Check `git config --get-all remote.upstream.fetch` if in doubt.

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
mid-run. Upstream does not rewrite a tag in place, so a rejected non-fast-forward tag update means
something is wrong: STOP and report rather than forcing it. It does sometimes **delete** one, which
is a different failure and is caught in Step 2 rather than here.

Capture these and keep them; every restore path depends on them:

```sh
ORIGIN_MAIN_OLD=$(git rev-parse origin/main)
UPSTREAM_MAIN=$(git rev-parse upstream/main)
ORIGIN_UPSTREAM_OLD=$(git rev-parse origin/upstream)
```

`$UPSTREAM_MAIN` is needed for the mirror branch in Step 12, the fork-commit range in Step 2, and
the informational gap in Step 16. It is never the merge target.

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

- **Before the ancestry test, check that the target is not _older_ than what `main` carries.**
  Read `upstream_synced` from `CHANGELOG.md`'s YAML frontmatter and compare by version order:

  ```sh
  SYNCED=$(sed -n 's/^upstream_synced: *//p' CHANGELOG.md | head -1)
  [ "$STABLE_TAG" = "$SYNCED" ] \
    || [ "$(printf '%s\n%s\n' "$STABLE_TAG" "$SYNCED" | sort -V | tail -1)" = "$STABLE_TAG" ] \
    || echo 'target is OLDER than upstream_synced'
  ```

  Equal is the ordinary quiet day and must fall through to the next bullet, which handles it as a
  success — only a strictly older target is the finding here, so the equality test comes first and
  short-circuits.

  If the target is older, upstream has **retracted** a stable tag this fork already absorbed. Record
  "no new stable release", skip to Step 12, and raise it as a "needs attention" item. Do not merge:
  Step 6 resets every upstream-owned file to `$UPSTREAM_TARGET`, so merging an older tag rolls the
  whole fork back a release and breaks any fork commit written against the newer release's API
  shapes. `merge-base --is-ancestor` cannot catch this on its own — stable tags live on their own
  release branches, so it fails for an _older_ tag exactly as it does for a genuinely new one.

- If `git merge-base --is-ancestor "$UPSTREAM_TARGET" origin/main` succeeds, `main` already contains
  this release. Skip to Step 12 and note "no new stable release (already at $STABLE_TAG)". This is
  the expected outcome on most days and is a success, not a warning.
- If N is 0 and `git merge-base --is-ancestor origin/main "$UPSTREAM_TARGET"` succeeds, this is a
  plain fast-forward — the fork has no commits of its own to defend. Record
  `resolution=fast-forward`, do Step 4, then set the run branch to the tag
  (`git reset --hard "$UPSTREAM_TARGET"`) and skip to Step 8. It still lands through a PR; there is
  no direct push to `main` anywhere in this flow.
- Otherwise continue.

Then check that the **previous** stable tag is still an ancestor:

```sh
git merge-base --is-ancestor "$PREV_TAG" origin/main
```

If it fails, the last sync PR was squash-merged. `main` still carries that release's _content_, so
nothing looks wrong, but the tag commit is gone from the lineage and `git merge` resolves its base a
release further back — v1.4.205 merged against a v1.4.203-era base and produced 2,536 differing
paths and 287 conflicted files instead of a one-release step. Proceed with the normal procedure:
`-X ours` plus Step 6 still resolve it, and `$PREV_TAG` is still the right content baseline for
every Step 6 audit diff. But say so in the report — it is a violated invariant of this flow, not a
quirk of the release — and expect the ownership lists to be several times their usual size.

### An earlier run's PR may already resolve this tag

This automation opens one run a day, and a run that stops with CI red leaves its PR open. The next
run resolves the same `$STABLE_TAG` from the same unchanged `main` and would merge it a second time,
racing a duplicate PR against the first. Check before Step 3:

```sh
env -u GITHUB_TOKEN gh pr list --repo zpyoung/orca --state open \
  --json number,title,url,headRefName,headRefOid
```

**A sync PR for an older tag is this run's base: stack on it, then close it.** If an open PR is
titled `sync: absorb upstream <tag>` for a tag older than `$STABLE_TAG`, upstream shipped a newer
stable release while an earlier sync was still unlanded. Merging `$STABLE_TAG` onto a fresh `main`
would re-derive that PR's resolution and race it, and adopting it fails by construction, since
stable tags live on per-release branches and the older tag is not an ancestor of the newer one.
Build on its resolution instead:

1. Check it as a base with the adoption checks below, testing that **its** tag is merged in place
   of `$UPSTREAM_TARGET`. If it is not built on today's `main`, merge `main` into it first exactly
   as that section describes. Red CI on it is not a reason to skip it: its failures become this
   run's, and most of them are still real against the newer tag.
2. Back up as Step 3 says. In Step 4, reset to the older PR's head instead of `$ORIGIN_MAIN_OLD`,
   and run Steps 5–8 as usual from there, with the older tag as `$PREV_TAG` for every Step 6 audit
   diff: its resolution is already in the tree.
3. At Step 9, open the new PR, then close the older one with a comment naming its successor:
   `env -u GITHUB_TOKEN gh pr close <n> --repo zpyoung/orca --comment "Superseded by #<new>, which
   carries this resolution and $STABLE_TAG."` Leave its branch and backup ref alone.

Landing the new PR lands both tags in one merge commit. Proven 2026-10-19: #122 (v1.4.230) on #120
(v1.4.227). This used to be a hard stop, and it stalled the sync for days at a time: 2026-09-10
(#48), 2026-09-26 (#92), and 2026-10-17 through 2026-10-19 (#120).

A PR titled `sync: absorb upstream $STABLE_TAG` is this run's work, already done. **Adopt it — do not
re-merge.** Verify it before you build on it, because its body is its own account and not evidence:

```sh
git fetch origin "$PR_BRANCH"
git merge-base --is-ancestor "$UPSTREAM_TARGET" "$PR_HEAD"      # the tag really is merged
git merge-base --is-ancestor "$ORIGIN_MAIN_OLD" "$PR_HEAD"      # it is built on today's main
git rev-list "$PR_HEAD" | sort > /tmp/reachable                  # every FORK_COMMITS SHA present
git ls-remote origin "refs/heads/${ITS_BACKUP_REF}"              # its backup still resolves to main
git diff --stat origin/main.."$PR_HEAD" -- .claude/skills/sync-upstream/   # must be empty
```

Use set operations for the reachability check, never a shell loop — `git` inside a `for`/`while`
body is "command not found" under the sandbox, which silently inverts every conditional.

If all five hold, that PR's backup ref is this run's backup (do not mint a second one at the same
SHA), and its head is this run's tree: do the Step 4 workspace checks, `git reset --hard` to its
head, `pnpm install --frozen-lockfile`, and continue at **Step 10**. Steps 5–8 are already done and
their evidence is in the PR body — re-run the Step 8 gate only after your own fixes. Push fixes to
**its** branch (`git push origin HEAD:refs/heads/<its-branch>`), never to `$SYNC_BRANCH`, and compute
the 4-hour budget from now rather than from the PR's creation. Append your account to its body rather
than replacing it. At Step 11 the branch to delete is that one.

If any of the five fails, the PR is not a safe base — leave it open, say so in the report, and run
the normal procedure from Step 3. **One exception: the "built on today's main" check.** An open sync
PR goes stale the moment anything else merges, and something else will — that check failed on
2026-09-10 because a fork feature had landed overnight, and GitHub had already flipped the PR to
`mergeable: false`, `mergeable_state: "dirty"`. Re-running from Step 3 there would throw away a
resolution that was otherwise complete and green. Merge `main` **into** the PR branch instead and
resolve, then continue at Step 10:

```sh
git reset --hard "$PR_HEAD"
git merge --no-edit origin/main
```

This merge is fork-against-fork, so `-X ours` is wrong here — it would discard whatever landed on
`main`, which is exactly the work you are trying to keep. Expect two shapes of conflict:

- **`config/fork-ownership.json` conflicts on nearly every entry.** The two sides reflowed the
  `residuals` block to different widths, so a textual merge reports formatting as content — 9 hunks
  on 2026-09-10. Merge it as parsed JSON instead: key `features` by `name`, `seams` by
  `(path, feature, kind)` (one path legitimately carries several seams, and a sync branch can hold
  exact duplicate entries that must be collapsed rather than treated as conflicts), and
  `exceptions`/`residuals` by `path`. Per key: `ours == theirs` take it; `theirs == base` take ours,
  which honors a deletion the sync made; `ours == base` take theirs; anything else is hand review.
  That produced **zero** value-level conflicts on the same merge. Format only that one file
  afterwards (`npx oxfmt --write config/fork-ownership.json`), never `pnpm format`.
- **Never merge residual numbers.** The two sides measured against different tags, so the merged
  value is meaningless either way. Re-measure with `--verify-residuals "$UPSTREAM_TARGET"` and
  re-baseline what it flags. A budget that _shrank_ is the normal case here and means the new
  release absorbed a line the fork was carrying — on 2026-09-10 upstream's own fixture fix
  superseded a workaround `main` had landed for the same bug, and taking upstream's side dropped
  three budgets from `+5/-2`, `+5/-2`, `+13/-4` to `+1/-1`, `+1/-1`, `+9/-3`.

Then re-run the Step 8 gate whole before pushing: the merge can break a file neither side broke.

### An undecided escalation may already block this tag

A run that stops on a human decision leaves no PR, so the check above cannot see it. It leaves a
ledger `decision` naming the tag and a `sync-resolved/<tag>-<stamp>` tag instead. Until someone
decides, every later run repeats the same merge against the same inputs and stops in the same place:
decision-298 stopped v1.4.222, v1.4.223 and v1.4.224 syncs on four consecutive days, the last two
against a `main` that had gained only README badge commits. Check before Step 3:

```sh
orca ledger list --type decision --state open --json   # titles naming a sync tag
git log --oneline --no-merges "<that run's backup ref>"..origin/main \
  | grep -v 'Update README downloads badge'
git diff --stat "<that run's tag>" "$UPSTREAM_TARGET" -- <the files the decision names>
```

If the decision is still `proposed`, `main` gained no fork commit since the run that raised it, and
the new tag leaves the decision's files unchanged, stop before Step 3 and report "needs attention:
<decision id> is still undecided; nothing merged". The run cannot settle the decision, and re-running
the merge only re-proves it. If any of the three has moved, run the normal procedure: the collision
may have dissolved, and that is worth finding out.

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

## Step 4 — Confirm the run workspace

The caller supplies the workspace: a fresh worktree on a disposable branch. Verify what you were
handed and stop rather than adapting to a workspace that fails any of these:

- `git symbolic-ref --short HEAD` resolves (HEAD is not detached) and is **not** `main`. Merging on
  `main` would put the resolution on the branch the PR targets.
- `git status --porcelain` is empty.
- No rebase/merge/cherry-pick is in progress. Resolve each path with `git rev-parse --git-path`
  (`MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`) and test what it prints. A
  literal `.git/MERGE_HEAD` test can never fire here: the run always happens in a worktree, where
  `.git` is a _file_ pointing at `<main repo>/.git/worktrees/<name>/`, so every `.git/<state>` path
  reads as absent no matter what is in progress.
- `git merge-base --is-ancestor HEAD origin/main` succeeds. The branch carries no commits of its
  own, so the reset below destroys nothing. If it fails, the workspace holds someone's work.

Record the branch and align it with the tip Step 2 assessed:

```sh
SYNC_BRANCH=$(git symbolic-ref --short HEAD)
git reset --hard "$ORIGIN_MAIN_OLD"
```

A fresh worktree has no `node_modules`, and the verification gate and any fix need them. Install
before merging, so an install failure is never mistaken for a resolution failure:

```sh
pnpm install --frozen-lockfile
```

**One dirty-tree case is not someone's work and must not stop the run.** The worktree setup installs
with whatever `pnpm` is on `PATH`, and an ambient pnpm 10 rewrites the pnpm-12 lockfile in place —
`pnpm-lock.yaml` alone modified, its `packageManagerDependencies` block dropped and the rest
reflowed. Confirm it is only that file and only that shape, then restore it and take the pinned
toolchain for the whole run, since `package.json`'s `packageManager` is not self-enforcing here:

```sh
git checkout -- pnpm-lock.yaml
corepack pnpm -v            # must print the packageManager pin, e.g. 12.0.0
```

Put a `pnpm` shim that execs `corepack pnpm` at the front of `PATH` for the run — repo scripts
invoke bare `pnpm` internally, so switching only your own calls is not enough. Anything else dirty
is a stop.

If any check or the install fails, STOP and go to Step 16 with "needs attention: unusable run
workspace (<which check failed>) — nothing merged, nothing pushed".

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
  fork's file: `git checkout --ours -- <path>` then `git add -f <path>`. The `-f` is needed because
  `docs/**` is gitignored while upstream still tracks files under it, and a plain `git add` of a
  conflicted ignored path refuses with "paths are ignored" and exits non-zero.
- **"deleted by us / modified by them"** (the fork deleted it, upstream modified it) → honor the
  fork's deletion: `git rm -f <path>`.

Run the two rules as separate commands. Chained with `&&`, a refused `git add` silently skips
every `git rm`, and the commit then fails on paths you believed were resolved.

Then `git commit --no-edit --no-verify`. Record `resolution=auto-ours+tree` and log every path
touched with the rule applied. `--no-verify` is required, not a shortcut: husky's pre-commit hook
runs `oxlint` over the staged tree, and the `-X ours` tree is exactly the tree Step 6 exists to
repair — it routinely carries a duplicate declaration or a broken brace pair, so the hook rejects
the merge commit and lint-staged reverts your resolution. Step 8 is this run's lint gate, and it
runs on the repaired tree.

Anything else — rename/rename, rename/delete, submodule conflicts, binary files you cannot attribute
to a side, or more than 25 conflicted paths in total — is out of scope. Do not guess. Run
`git merge --abort` and go to Step 16 with "needs attention: merge conflicts require manual
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

`-X ours` resolved every conflicting hunk in those files toward the fork, so re-merge each seam file
without it (`git merge-file --diff3 -p` with `$MERGE_HEAD_PRE`, `$PREV_TAG`, `$UPSTREAM_TARGET`) and
resolve every file that reports a conflict. Do this even where `--verify-residuals` passes: a
discarded upstream hunk the same size as the fork's keeps the budget intact. v1.4.215 had two such
files that the residual check never flagged: `pr-e2e-gate-contract.test.mjs`, still naming a job
upstream had retired, and `NativeChatToolLine.tsx`, with a hover-group rename lost.

The `ours.txt` three-way merge has a matching blind spot. A clean merge imports upstream's new
assertions into an exception-owned contract test even when they name a workflow or job the fork
deletes. v1.4.215 did this for `track-community-prs.yaml` and `package_windows`. Nothing flags it
until PR CI, so grep every merged exception test for the paths the manifest marks `deleted: true`
and for jobs missing from the fork's `pr.yml`.

The reference also carries three per-sync checklists that are part of this step, not optional
extras: **tier-2 forked-copy replay**, **tier-4 pending-upstream review**, and **upstream
feature-collision review**. Each can surface a decision the reference routes to a human. Escalate
it as the Arguments section describes rather than choosing a side, and only an unanswered ask goes
to Step 16 with "needs attention: <the decision>".

**`ours.txt` is the list that loses work silently, so audit it.** An exception wins the whole file,
which also discards every unrelated upstream change under that path — no conflict, no marker, and
both manifest checks still pass. Diff each restored path over the old-to-new tag range and replay
what the fork does not actually own:

```sh
while read -r p; do
  [ -z "$p" ] && continue
  git diff --numstat "$PREV_TAG" "$UPSTREAM_TARGET" -- "$p"
done < <out-dir>/ours.txt
```

Every path this prints is a decision, and the decision is **always** a three-way merge with the
previous tag as base (`git merge-file --diff3 -p ours base theirs`) — never a judgement read off the
exception's `reason`. The fork's own lines and upstream's usually sit in different regions and merge
cleanly, so the merge costs nothing and is the only thing that actually separates the delta the fork
owns from the file it happens to live in. Resolve a genuine conflict in the fork's favour only where
the exception's `reason` is what upstream's side would undo — a fork build artifact, a fork identity
file, or a record the reason says upstream's copy actively breaks.

**A four-digit removal on an `ours.txt` path is a module split, not lost fork work.** The numstat
above is the only tell an exception ever gets: `--verify-residuals` reads `seams` alone, so a split
that lands on an exception-owned file is invisible to every manifest check. v1.4.197 split three at
once — `src/main/updater.ts` (2,353 lines to a 94-line barrel), `src/main/rate-limits/service.ts`
(2,182 to 10) and `TerminalPane.tsx` (3,505 to 15) — and the exception would have defended all three
monoliths while the merge added the new modules beside them. Do not three-way merge one of these;
re-home it by the recipe in [`references/sync-lessons.md`](./references/sync-lessons.md), which now
covers the exception case as well as the seam case.

**Before designing the re-home, read the test files that arrived beside the split.** A release that
dissolves a monolith tends to pin the result, and the pins are exact equalities — a `toHaveLength`,
a `_SHA256` of a flattened hook or listener order, a `LISTENER_BUDGET` compared with `toBe`. If the
fork feature that lived in the monolith necessarily adds hooks or store subscriptions inside the
pinned file set, no re-home satisfies them and re-baselining the constants is the baseline bump the
fix policy forbids. That is a confirmed feature collision: stop and raise it, rather than spending
the hour first.

A `reason` that reads like whole-file ownership ("the fork's release-tooling delta", "fork-specific
thresholds") is exactly where this goes wrong: it is describing a _delta_, and the exception is
keeping the whole file. v1.4.194 lost four that way — the Electron installer's staging-transaction
rework, the packaged-runtime contract's move off `package.json`'s `pnpm` block, release-cut's new
permission row, and `pr.yml`'s new real-IME lane. Every one passed both manifest checks, the local
gate, and the ownership guard, and every one failed in PR CI instead.

The release workflows are the worse case, because PR CI is not their safety net either — nothing in
`pr.yml` runs `release-cut.yml` or `release-mac-build.yml`, so an exception that discards an upstream
toolchain bump there stays green until someone cuts a release. Give them a targeted pass:

```sh
git diff "$PREV_TAG" "$UPSTREAM_TARGET" -- .github/ | grep -E '^[-+].*(uses:|version:|node-version|packageManager)'
```

Upstream's move from `pnpm/action-setup@v6` + `version: 10.24.0` to `pnpm/setup@v2` + `install: false`
is the one that has already cost two releases: `packageManager` is upstream-owned and reached
`pnpm@12.0.0`, while the fork's exception-owned copies kept the pin, and `action-setup` hard-errors on
`Multiple versions of pnpm specified`. Replay a toolchain bump into the fork's copies unless the
exception's `reason` is specifically about that toolchain.

**`checkout.txt` reverts undeclared fork edits, so sweep it.** A fork edit to an upstream-owned
file that no `seams` entry declares is invisible to every check — the guard permits it, and
ownership resolution then correctly resets the file to the tag and drops it. Nothing reports this;
it surfaces as an unrelated-looking CI failure hours later. List them before committing:

```sh
python3 - <out-dir>/checkout.txt "$PREV_TAG" "$MERGE_HEAD_PRE" <<'EOF'
import subprocess, sys
paths = [p.strip() for p in open(sys.argv[1]).read().split('\n')]
paths = [p for p in paths if p]
def tree(ref):
    r = subprocess.run(['git', 'ls-tree', '-r', '--format=%(path)\t%(objectname)', ref],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'git ls-tree failed for {ref}: {r.stderr.strip()}')
    return dict(line.split('\t', 1) for line in r.stdout.splitlines() if '\t' in line)
prev, fork = tree(sys.argv[2]), tree(sys.argv[3])
for p in paths:
    if p in prev and p in fork and prev[p] != fork[p]:
        print(p)
EOF
```

It exits non-zero if either ref cannot be read, so an empty print means no undeclared edits rather
than a failed lookup. Every path it prints is a fork edit the reset just threw away. Restore it from
`$MERGE_HEAD_PRE` (three-way merged against the tag, since upstream may have changed the same file),
then **declare it as a seam** — that is what stops the next sync reverting it again. v1.4.194 printed seven, and all
seven were real: two cross-version tests pinning fork release refs, two PR-workflow contract tests
that must know `fork_ownership_guard` is ungated, a ratchet inventory counting a fork dialog, an
import repointed at a forked copy, and a relay test mocking the fork's transport.

**First ask whether the fork's side diverges at all.** An exception is a standing claim, and nothing
re-checks that the claim is still true, so a path can keep winning long after the fork stopped
differing from upstream there. Where the fork's side is byte-identical to the previous tag, there is
no fork content to weigh and no decision to make — take upstream's file wholesale:

```sh
while read -r p; do
  [ -z "$p" ] && continue
  git cat-file -e "${PREV_TAG}:${p}" 2>/dev/null || continue
  git diff --quiet "$PREV_TAG" "$MERGE_HEAD_PRE" -- "$p" && echo "stale exception: $p"
done < <out-dir>/ours.txt
```

Run this before the numstat loop; it removes paths from the decision list rather than adding them.

The same staleness also hides _inside_ a path that does diverge, where it reads as deliberate fork
intent. Before defending a hunk the fork appears to have deleted, check whether a fork commit ever
touched it — `git log -S'<symbol>' -- <path>` returning only upstream commits means the exception
discarded upstream's addition at some earlier sync and no one chose anything.

`package.json` is the one that fails loudest and least obviously: `pnpm-lock.yaml` is upstream-owned
and resolves to the tag, so a dependency the exception dropped makes `pnpm install --frozen-lockfile`
fail in Step 8 with a lockfile error that names nothing about ownership.

**A `deleted: true` exception can be invalidated by the release you are merging.** The fork's
deletions were decided against the _previous_ tag's import graph; a new release can add files that
import a module the fork deletes. Nothing reports it — `remove.txt` honours the deletion, both
manifest checks pass, and the ownership guard passes — so it surfaces as `TS2307` against upstream's
own new files. Sweep right after `remove.txt` is applied.

Grep the **merged working tree**, not `$UPSTREAM_TARGET`. The tag is upstream's view, where nothing
the fork deletes has been deleted and nothing it replaces has been replaced, so every consumer the
fork owns still carries its upstream import there and the sweep reports it. On v1.4.207 a
tag-reading form printed three findings against a true answer of zero. The merged tree is also the
tree `tsc` compiles, so a hit here is the `TS2307` you would otherwise meet in Step 8:

```sh
python3 - <<'SWEEP'
import json, subprocess
m = json.load(open('config/fork-ownership.json'))
gone = {e['path'] for e in m['exceptions'] if e.get('deleted')}
hit = False
for p in sorted(gone):
    mod = p.rsplit('/', 1)[-1].rsplit('.', 1)[0]
    live = subprocess.run(['git', 'grep', '-lE', f"from '[^']*/{mod}'"],
                          capture_output=True, text=True).stdout.split()
    if live:
        hit = True
        print(f'{p} still imported by {len(live)}: {live[:3]}')
print('NONE' if not hit else '^^ withdraw the deletion')
SWEEP
```

Match an import specifier, not a bare occurrence of the module name: a `vi.mock('./mod', () => ...)`
with a factory never resolves the module, so it is not evidence of anything.

Withdraw the deletion rather than extending it: restore the module and its test from the tag and
drop the exception. Never delete the new upstream files to match, and never repoint an upstream
import at the fork's replacement unless that module really provides the same surface. See
[`references/sync-lessons.md`](./references/sync-lessons.md) for the v1.4.200 case.

**A bare upstream tag pinned in a cross-version test needs no repoint.** The exception-owned
`tests/e2e/cross-version-wire/release-checkout.ts` has `resolveUpstreamStableTag`, which fetches a
strict `vX.Y.Z` from stablyai/orca into `refs/remotes/upstream-releases/`. Upstream's pins therefore
resolve in PR CI even though this remote has none of those tags: #131's `cross-version wire
compatibility` passed with `v1.4.218` absent from origin. Only confirm the function survived the merge:

```sh
git grep -n resolveUpstreamStableTag -- tests/e2e/cross-version-wire/release-checkout.ts
```

If it's gone, restore it rather than repointing constants.

**Sweep the release for upstream identity the fork must not inherit.** Upstream hardcodes its own
signing team, bundle ids, runners and repository, and every new hardcode resets to the tag here.
v1.4.230 brought five: its skills install URL and Blacksmith runner labels failed PR CI, and its Apple
team id `6CX3WHS9HZ` passed PR CI and failed the first release build, which is the only place
signing is checked:

```sh
git diff --name-only -G '6CX3WHS9HZ|com\.stablyai|blacksmith-|stablyai/orca' \
  "$PREV_TAG" "$UPSTREAM_TARGET" -- . ':!docs' ':!*.md' ':!*.test.*' ':!*.spec.*' ':!**/tests/**'
```

Every listed file is a decision. A user-facing link to upstream stays: pointing those at upstream
is deliberate. Anything the fork's build, signing, release, CI runners or skill installs read must
end up fork-owned, as a seam or an exception, before the push. A hit in a file the fork already
owns is usually upstream's new code next to the fork's existing override, so read the merged file
rather than the diff.

Commit the ownership resolution as a single follow-up commit on top of the merge, again with
`--no-verify` for the reason in Step 5; Step 7 expects exactly one such extra commit.

If the classifier fails, or `checkout.txt` is empty when the merge was not a no-op, STOP and go to
Step 16 with "needs attention: ownership resolution failed". Do not fall back to plain `-X ours` —
that is the known-broken state.

## Step 7 — Commit accounting

Merging never replays fork commits, so unlike a rebase it cannot silently drop or rewrite them. That
makes this check strict and cheap: every SHA in FORK_COMMITS must still be present and reachable.

For each SHA recorded in Step 2, `git merge-base --is-ancestor <sha> HEAD` must succeed. If any does
not, something rewrote history — reset back (`git reset --hard $ORIGIN_MAIN_OLD`) and go to
Step 16 with "needs attention: fork commit <sha> <subject> is no longer reachable after merge".

Also re-run the Step 2 range against the merged head —
`git log --oneline --no-merges HEAD --not upstream/main "$UPSTREAM_TARGET"` — and confirm the count
is still N. A count above N is fine only if the extras are the merge resolution and the Step 6
ownership commit; a count below N is a hard failure.

## The fix policy — how Steps 8 and 10 handle a failure

Both gates run under one rule: fix what can be fixed, escalate only what genuinely needs a person.

**Diagnose before patching.** A failure right after a sync is a resolution failure until proven
otherwise — the merge kept upstream's side of a file the fork owns, or the fork's side of a file
upstream reworked. Re-run the Step 6 classifier against the failing path and correct ownership
first. Patching fork code to silence a symptom whose cause is a mis-resolved file buries the bug and
re-breaks at the next sync.

A fix may:

- re-resolve a path to its declared owner, and correct the manifest itself — seam lines, residual
  budgets, tier-2 replay headers — when the declaration is what drifted
- adapt fork code to an upstream API that changed shape, preserving the fork behavior
- adopt an upstream test's new expectations where the fork has no stake in the old ones
- resolve a React Doctor finding on upstream code the release introduced. Every upstream line is a
  changed line on a sync PR, so `static analysis` reports findings upstream's own CI never sees.
  Rewrite upstream's code to satisfy the rule and declare the file `pending-upstream` under the
  existing ledger section — never add it to a suppression list
- apply lint and format fixes, committed one commit per rule. A stable tag can enable whole rule
  families that `--fix` cannot rewrite, and adopting those in fork-owned files **is the run's job** —
  it is never an escalation on its own. The fix is names and types only, taken from upstream's own
  adoption commit for that rule; `references/file-ownership.md` § _When upstream tightens the linter_
  has the method and its limits
- remove a job from the fork's `pr.yml` that the release cannot route: its `verify` selection has
  no producer in the tag's `pr-code-change-scope.mjs`, or a script it runs does not exist in the
  tag. `check-pr-verify-selections.mjs` (Step 8) names both cases. Remove the job, its `verify.needs`
  entry, its `check_job` line and its env, and file a ledger `deferred` entry to restore it once a
  stable tag ships the rest of the change: a later three-way merge against this tag sees only the
  fork's removal, so it never brings the job back on its own. v1.4.230's release branch shipped
  `dependency_isolation` that way (`597425845e`), and `verify` failed every PR until it was removed

Escalate — ask as the Arguments section describes, and on no answer stop, leave the PR open, and
report "needs attention" — for:

- any resolution that would cost fork feature functionality: upstream reworked the code a fork
  feature hangs off, and every fix available loses behavior this fork ships
- the Step 6 human decisions (feature collision, pending-upstream item, unresolvable conflict)
- an upstream defect the fork would have to work around — including a new lint rule that upstream's
  own release violates in its own file. Retarget to a newer stable tag first if one exists; that
  usually dissolves it. Prove the defect before retargeting: `pnpm test:sandbox --shards=1
  --source-ref="$UPSTREAM_TARGET" -- <test>` runs the bare tag, and an identical failure there is
  upstream's. To retarget with the PR already open, merge the newer tag into the same branch by
  Steps 5–8 with the old tag as `$PREV_TAG`, push, and retitle the PR; this skill never creates a
  branch. PR #129 did this when v1.4.232's clock-dependent `session-scanner-scope-cwd-facts` test
  failed and v1.4.233 (#31098) fixed it
- a single lint violation that cannot be cleared without changing what the code does. Adopt every
  other rule, and escalate that one file alone rather than the run

Never, on either gate:

- skip, delete, or narrow a test to make it pass
- add a `max-lines` disable or a per-file baseline bump — `AGENTS.md` forbids it outright
- weaken a lint rule, the fork ownership guard, or any other CI gate
- wave a failure through as unrelated. A red check is red until a re-run clears it or a fix turns it
  green; "probably pre-existing" is a thing to prove in Step 10, not a reason to move on

Each fix is its own commit, its message naming what broke and why the fix is the right one. Every
fix commit appears in the Step 16 report. Stage a fix by path (`git add <paths>`, or `git add -u`
for tracked files), never with `git add -A` or `git commit -a`.

## Step 8 — Verification gate

This gate is the cheap, local half of verification. It proves the tree coheres before a PR exists;
**PR CI owns the test suite** (Step 10). Do not run `pnpm test` here — see below.

Run the gate exactly as [`references/file-ownership.md`](./references/file-ownership.md) § Verifying
specifies, including the manifest checks (`--verify-seams`, `--verify-residuals`) and clearing
`config/*.tsbuildinfo` before every typecheck. Those are not hygiene; each one deterministically
fakes a result if skipped.

Order: `pnpm install --frozen-lockfile` (re-run it here — the merge may have taken upstream's
`pnpm-lock.yaml`) → manifest checks → typecheck → `pnpm lint` → the CI-parity checks below.

**Never run `pnpm typecheck` here.** `AGENTS.md` forbids it on this machine: it is
`run-typecheck-projects-in-parallel.mjs`, which spawns a `tsc --noEmit` per project concurrently,
and with several sync worktrees open that saturates every core. Run the projects it lists in
`TYPECHECK_PROJECTS` one after another instead — same coverage, no concurrency — clearing the build cache before each, since
composite projects cache errors across the `git checkout` swaps this step is full of:

```sh
find config -maxdepth 1 -name '*.tsbuildinfo' -delete && pnpm run typecheck:node
find config -maxdepth 1 -name '*.tsbuildinfo' -delete && pnpm run typecheck:web
find config -maxdepth 1 -name '*.tsbuildinfo' -delete && pnpm run typecheck:cli
```

Read the project list from the tag's `config/scripts/run-typecheck-projects-in-parallel.mjs` rather
than from here, because upstream edits it. v1.4.215 retired `config/tsconfig.mobile-web.json` in
#22193, and a gate that still ran it failed with a missing-file error that names no type problem.

Separate commands on purpose, not a loop: under the sandboxed shell a command in a `for` body
can come back "command not found", which inverts the result silently, and a loop's `|| break` would
swallow the exit code this gate turns on. Read each one's status before running the next. `zsh` has
no `PIPESTATUS`, so do not pipe these into `tail` and expect `$?` to mean anything — redirect to a
file instead.

`typecheck:e2e` is **not** one of them, and running it will cost you a diagnosis. It is absent from
`pnpm typecheck` and from the `typecheck` job in `pr.yml`, so `config/tsconfig.e2e.json` has drifted
unchecked — 216 errors across 110 files on `main` at v1.4.207, none of them a sync's doing. Do not
add it to the gate, and do not treat its output as merge damage.

**Then run what PR CI checks before any test starts.** The `static analysis and typecheck` job
stops at its first failing step and the unit shards wait behind it, so every step this gate skips
costs a whole CI round to discover. v1.4.230 spent four rounds there, one new step each, and its
unit tests first ran on the fifth push. Commit first, because two of these read committed state,
then run each as its own command:

```sh
git status --porcelain --untracked-files=all       # must print nothing
node config/scripts/fork-sync-gate/check-pr-verify-selections.mjs
node .github/scripts/check-root-directory-entries.mjs "$(git merge-base origin/main HEAD)" HEAD
node .github/scripts/check-fork-ownership.mjs "$(git rev-parse origin/main)" "$(git rev-parse HEAD)"
node config/scripts/fork-sync-gate/replay-pr-preflight.mjs
```

- **The clean-tree check** catches build output before it is committed. Benchmark and sandbox runs
  write into the tree, and `git add -A` swept `.build/release-javascript-measurements/` into a
  v1.4.230 fix commit, which failed both guards below.
- **`check-pr-verify-selections.mjs`** proves `pr.yml` can route every job `verify` requires and
  that every script it runs exists. The fix policy says what to do when it names a job the release
  cannot route.
- **The two guards** are `pr.yml`'s own repository checks, run exactly as CI runs them.
- **`replay-pr-preflight.mjs`** reads the `preflight` job out of `pr.yml` and runs every step it can
  locally, in order, without stopping at the first failure. It skips the typecheck (run above, one
  project at a time) and steps whose condition only CI can evaluate, and names each skip. A full
  replay takes about three minutes.

Every step is absolute: stop at the first failure and treat it as a hard fail. The reference's
rule-tightening carve-out is the one exception, and it is an exception about _how the tree is
fixed_, not about tolerating a failure — lint must still pass before the push, and the mechanical
`oxlint --fix` it permits is committed separately from the merge and the ownership commit.

**Why no tests here.** Vitest cannot run on the machine this skill runs on; `AGENTS.md` routes every
local run through a remote Docker host, and that host is a single shared box. Sharded across it the
suite reports failures the code did not cause — timeouts, perf budgets, and temp-file races that
land on a different random subset each run and clear the moment the same files run alone. Chasing
them costs the run an hour and answers a question PR CI answers properly: the `test` matrix in
`.github/workflows/pr.yml` runs the same suite sharded across clean hosted runners, and it is a
required check for `verify`. A local pass never authorized a merge, and a local failure was never
trustworthy on its own — so the local run buys nothing the PR does not.

A hard fail here is not the end of the run — work it under the fix policy above, then re-run the
gate from the top. Re-run it whole: a fix for a typecheck error routinely breaks lint, and a partial
re-run is how a broken tree reaches the PR.

If the policy says escalate, or the same failure survives your fixes, **tag the resolution before
you throw it away**. The reset is mandatory, but a run that escalates has usually produced a
complete, correct resolution that only a human decision blocks, and the tag lives in the shared
`.git`, so it survives this worktree being deleted:

```sh
git tag "sync-resolved/${STABLE_TAG}-<stamp>" HEAD
```

Name that tag and its SHA in the report, so the rerun after the decision starts from it instead of
redoing hours of ownership work. Then restore and bail:
`git reset --hard $ORIGIN_MAIN_OLD`, then go to Step 16 with "needs attention: merge resolved but
<install|manifest|typecheck|lint> failed — manual resolution required; backup at
origin/<BACKUP_REF>". Include the first ~20 lines of the failure output.

Never open a PR from a tree that failed this gate. Typecheck and lint are seconds of work that would
otherwise cost a CI round trip, and a red PR spends the run's 4-hour Step 10 budget on something the
merge already knew.

## Step 9 — Push the run branch and open the PR

```sh
git push -u origin "$SYNC_BRANCH"
```

NEVER use `--force` or `--force-with-lease`. The branch is created fresh for this run, so a rejected
push means the workspace was not fresh after all: STOP and report rather than overwriting.

Write the PR body to a file and open the PR. Both flags are required — without `env -u GITHUB_TOKEN`
and an explicit `--repo`, `gh` fails here in a way that misreports its own cause:

```sh
env -u GITHUB_TOKEN gh pr create --repo zpyoung/orca \
  --base main --head "$SYNC_BRANCH" \
  --title "sync: absorb upstream ${STABLE_TAG}" \
  --body-file <path to the body file>
```

The body is the reviewer's whole account of the resolution, and the Step 16 report is built from the
same material. Include: `$STABLE_TAG` at `$UPSTREAM_TARGET`; the resolution mode; the fork-commit
count N with confirmation every SHA is still reachable; each ownership list and what came from it;
every `merge-review.txt` path with what the hand review concluded; the tier-2, tier-4, and
feature-collision checklist outcomes; what the Step 8 gate covered (and that tests are left to this
PR's own CI); and the backup ref.

**Label the PR at creation when the release bumps the daemon protocol.**
`check-runtime-launcher-protocol-ratchet.mjs` fails `cross-version wire compatibility` when one diff
changes `PROTOCOL_VERSION` and any of its `RUNTIME_LAUNCHER_PATHS`, and a sync diff carries
upstream's separate PRs for the two as one. If
`git diff "$PREV_TAG" "$UPSTREAM_TARGET" -- src/main/daemon/daemon-protocol-version.ts` is non-empty,
pass `--label allow-runtime-launcher-protocol-bump` to `gh pr create`; #115, #122 and #129 all
needed it. `pr.yml` has no `labeled` trigger, so a label added after the first run counts only from
the next push.

Record `PR_NUMBER` and `PR_URL`. If a PR already exists for this branch, reuse it
(`env -u GITHUB_TOKEN gh pr view "$SYNC_BRANCH" --repo zpyoung/orca --json number,url`) instead of
opening a second one.

**One writer per sync PR.** Two sessions drove #122 at once: commits landed while the lead waited
on a poll, and the two merge commands ran two seconds apart. Record yourself as its driver
(`orca worktree set --worktree active --comment "driving PR #<n> from session <id>" --json`). Before
every push, fetch the branch and confirm its head is the commit you last pushed or adopted. A head
you did not write means another writer is active: stop editing, read its commits, and continue
from them or step back, rather than pushing over them. The wait in Step 10 exits on exactly that.

## Step 10 — Drive the PR green

The run owns this PR until its gate passes or the budget runs out. The budget is **4 hours** from
PR creation, not counting time spent waiting on an answer to an ask; compute the deadline once and
honor it.

**Gating and advisory checks.** The merge gate is the `PR checks passed` job (job id `verify`) of the
`PR Checks` workflow, `.github/workflows/pr.yml`, on the PR's exact head commit, and every job of
that workflow is gating. Every other workflow's check is advisory: the benchmark comparisons, the
SSH host matrices, `updater` and the rest. Advisory checks are reported and never block the merge. A
failed advisory check is re-run once when its log shows a runner or network fault, and is named in
the report either way. Don't fix one in a sync PR: the benchmark workflows already carry fork-aware
baselines (`fork-benchmark-baseline`), and they still fail on a sync-sized diff by construction.

Wait with this bounded foreground command, repeated, which polls every two minutes (`gh` shares the
account's API rate limit, so do not tighten it):

```sh
node config/scripts/fork-sync-gate/wait-pr-checks.mjs --pr "$PR_NUMBER" --head "$(git rev-parse HEAD)" \
  --advisory-minutes 15 --timeout-minutes 9
```

It exits `1` on the first failed gating job and names it, which is usually well before `verify`
settles. It exits `0` once the gate is green and the advisory checks have settled, or 15 minutes
after the gate went green, whichever comes first. It exits `3` when the head moves under you (see
_One writer per sync PR_), `4` when the PR closes, and `2` at its own deadline, which only means run
it again while the 4-hour budget lasts. Read `verify`'s own log
when it fails: it is not a rollup, and its last lines name the selection or job that failed.

This is where the test suite runs, so a failing `tests node <version> <shard>/<total>` check is the
run's problem to resolve, exactly like any other check.

**Read a failing job's log through the API, not `gh run view`.** While any job in the run is still
going, `gh run view --log-failed` answers `run <id> is still in progress; logs will be available
when it is complete` and prints nothing — and a 16-way shard matrix is almost never all-settled when
the first failure appears. Fetch the one job instead, which works immediately:

```sh
env -u GITHUB_TOKEN gh api "repos/zpyoung/orca/actions/jobs/<job-id>/logs" > job.log
```

The job id is the trailing number of the `link` field in `gh pr checks`. Strip the ANSI codes
(`sed 's/\x1b\[[0-9;]*m//g'`) before grepping for `FAIL `, and read the whole failure — one root
cause routinely fails several shards, and the file named in the first `##[error]` is often not the
file that has to change.

**Re-run a failure before believing it.** This suite is genuinely nondeterministic — failures differ
run to run on identical code. The first time a job fails, re-run it once
(`env -u GITHUB_TOKEN gh run rerun <run-id> --failed --repo zpyoung/orca`) and only treat it as real
if it reproduces. A failure that reproduces is signal; a failure that clears was flake, and it is
still worth naming in the report. A shard matrix gives you a cheaper first read than a re-run:
the same shard number failing on **both** Node versions is deterministic, and one version alone is
the flake shape. `gh run rerun` refuses with `cannot be rerun; This workflow is already running`
until every job has settled, so wait for the run rather than retrying the command.

**A CI failure can come from a poisoned Actions cache, not from the tree.** A `native-modules-*`
entry can hold the published prebuild rather than the patched build. Every later run on the same key
restores it, `rebuild-native-deps.mjs` sees the addon load and skips the rebuild, and a
patched-source guard then rejects it. v1.4.198 added exactly such a guard
(`ensure-native-runtime.mjs`: "the loaded addon still calls ReadProcessMemory"), and it failed
`real WSL terminal` on two consecutive runs of the same PR — reproducing, but not from the diff.

**The poison is self-perpetuating, and a green job is what writes it.** Do not look for a cancelled
run: on 2026-09-10 the entry that failed the job had been written the previous afternoon by the
_successful_ WSL job that the previous run's cache deletion had just produced. `rebuild-native-deps.mjs`
decides to skip from `probeElectronNativeModules`, which tests only whether the addon loads, while
the patched-source check runs later in `ensure-native-runtime.mjs` — so a restored prebuild loads,
the rebuild is skipped, and the guard rejects it. That file is byte-identical to upstream, so this is
an upstream defect: deleting the entry unblocks the run but does not stop the next one inheriting a
fresh bad entry. Expect to do this every sync until upstream's skip decision consults the guard.

The tell is a failure whose whole path is byte-identical to the tag. Prove that before anything else,
and diff the _real_ paths — the patches live in `config/patches/`, not `patches/`, and a diff of a
directory that does not exist reports no changes and looks like proof:

```sh
git diff --stat "$UPSTREAM_TARGET" HEAD -- config/patches/ config/scripts/ensure-native-runtime.mjs \
  config/scripts/rebuild-native-deps.mjs .github/actions/install-node-dependencies/
```

Then confirm the cache actually supplied the artifact, and find out who wrote it:

```sh
# in the job log: "Cache restored from key: native-modules-..."
env -u GITHUB_TOKEN gh api "repos/zpyoung/orca/actions/caches?per_page=100" \
  --jq '.actions_caches[] | select(.key|test("native-modules")) | "\(.id) | \(.key) | \(.ref) | \(.created_at)"'
```

The poison is the entry whose key the failing log names as restored — not whichever entry looks
suspect from its `created_at`. Delete just that entry and re-run the job:

```sh
env -u GITHUB_TOKEN gh api -X DELETE "repos/zpyoung/orca/actions/caches/<id>"
```

Delete only the one entry the failing log names, only after the run has settled so no in-flight
Windows job can re-save it, and only once the byte-identical check above has ruled out the diff.
Then re-run the job. If it passes, the cache was the cause; if it fails again on a clean cache, the
defect is real and that is the evidence to escalate with.

`gh run rerun --job <id>` answers `job <id> cannot be rerun` while any job in the run is still
going, and on a sync PR the e2e lane holds the run open for its full 45 minutes — so queue the
re-run behind a wait on run status rather than retrying the command. If you are pushing a fix
anyway, do that instead: the new run re-runs the job for free. Re-running a job also re-runs its
dependents, which is why `verify` cannot be re-run on its own and does not need to be.

Whether clearing a cache belongs on the fix policy's list of what a fix _may_ do is a question for
the skill's owner, not for a run to settle — raise it, do not assume it.

**A reproduced CI failure is the fork's to fix, even if the merge did not cause it.** There is no
tolerance mechanism here and there is no need for one: these are clean hosted runners, so the
machine-coupling that a local run has to argue away does not apply. If you believe a failure
pre-dates the sync, prove it — find the same job failing the same way on another PR, or on the run
`main` produced for its own tip — and then report it as "needs attention: pre-existing failure
blocking the sync PR", PR left open. Pre-existing is a reason to escalate, never a reason to merge
past a red required check.

Every real failure goes through the fix policy above: diagnose the cause, fix it if the policy
allows, commit it on its own, push, and let CI re-run. There is no fixed attempt limit — keep going
while you are making progress and the budget holds.

Stop and report "needs attention", PR left open, nothing merged, when: an escalation's ask goes
unanswered, the same check fails after a fix aimed at it, or the deadline passes. Name the check,
link the run, and state what you tried.

## Step 11 — Merge the PR

Only when the Step 10 wait exited `0`: `PR checks passed` is green on the exact head, and the
advisory window has closed. First append to the PR body every fix commit pushed since it opened and
every advisory check still failing or pending. Then merge that exact commit:

```sh
env -u GITHUB_TOKEN gh pr merge "$PR_NUMBER" --repo zpyoung/orca --merge \
  --match-head-commit "$(git rev-parse HEAD)"
```

`--match-head-commit` refuses the merge if another writer pushed after the wait cleared it.

`--merge` is mandatory. `--squash` and `--rebase` both mint new SHAs, which breaks this fork in two
ways at once: it flattens the merge with `$UPSTREAM_TARGET`, so every later sync re-conflicts
against a tag `main` no longer descends from, and it rewrites fork commit SHAs, so
`last_released_commit` dangles and published release tags point into a dead lineage. This is the
"merge, never rebase" invariant, enforced at the moment it is easiest to violate.

If the merge is refused — branch protection wanting a review, a check that became required
mid-run — do not work around it. Try arming auto-merge
(`env -u GITHUB_TOKEN gh pr merge "$PR_NUMBER" --repo zpyoung/orca --merge --auto`; the fork
currently has auto-merge disabled in its settings, so expect this to fail and do not enable it to
get past a refusal), then report "needs attention: PR could not be merged by the run (<reason>)"
and skip the release — `main` has not moved.

Then confirm and capture the new tip:

```sh
git fetch origin main
MAIN_NEW=$(git rev-parse origin/main)
git merge-base --is-ancestor "$UPSTREAM_TARGET" origin/main   # must succeed
git rev-list --parents -n1 "$MAIN_NEW" | wc -w                # must be 3: the commit and two parents
```

**Both checks are load-bearing — run them and act on the result.** A squash puts the tag's
_content_ on `main` while leaving its _commit_ out of the lineage, so the ancestor check fails and
the parent count reads 2 instead of 3. Verified on PR #82: after it was squashed,
`git merge-base --is-ancestor v1.4.204 origin/main` exits 1 while `main`'s tree verifies clean
against v1.4.204. The parent count is the more direct signal, because it also catches a rebase
merge, whose single parent still carries the content forward.

Nothing else notices for a long time, and what eventually does is confusing. The fork ownership
guard picks the newest stable tag _reachable from HEAD_, so it silently falls back a release and
reports every seam re-baselined since as drift — on **every** PR, including ones that touch nothing.
#82 left #83 red that way, with ~25 false residual failures and no fault of its own. The next sync
then merges against a base a release further back: v1.4.205 resolved against a v1.4.203-era base and
produced 2,536 differing paths and 287 conflicted files for what should have been a one-release step.

If either check fails, `main` has the content but not the lineage. Do not reset or force anything —
the next sync's own merge commit restores the ancestry. Report "needs attention: $STABLE_TAG was not
merged as a merge commit — the ownership guard will compare every PR against $PREV_TAG", and name
the tag the next run will find missing. The repo still allows `allow_squash_merge` and
`allow_rebase_merge`, so this can recur; turning them off is the repo owner's call, not the run's.

The fork does not delete branches on merge, and this automation opens one a day, so clean up the
remote branch best-effort: `git push origin --delete "$SYNC_BRANCH"`. A failure here is worth a line
in the report and nothing more. Leave the local branch and the worktree alone — they belong to the
caller.

## Step 12 — Update the fork's `upstream` mirror branch

The mirror branch tracks upstream's **trunk**, deliberately — it is a read-only convenience copy of
`upstream/main`, not a record of what was synced. Do not repoint it at `$STABLE_TAG`.

If `git merge-base --is-ancestor origin/upstream upstream/main` succeeds, fast-forward it:
`git push origin upstream/main:refs/heads/upstream`. Otherwise it has diverged — do NOT force.
Record "needs attention: upstream mirror branch diverged".

## Step 13 — Prune old backups

List `git ls-remote --heads origin 'refs/heads/backup/main-*'`. If more than 10 exist, delete the
oldest by stamp so 10 remain: `git push origin --delete refs/heads/backup/main-<stamp>`. Only ever
delete refs matching that exact pattern, and never the backup created by this run.

## Step 14 — Cut a release

Run this step only if ALL of the following hold. If any fails, skip it and record in Step 16 that no
release was attempted, with the reason.

- No hard fail occurred in Steps 3–11: the backup landed, no unresolvable conflict, commit
  accounting passed, the verification gate passed, and **the PR merged**. A Step 12 mirror-branch
  warning does NOT block a release — it does not touch `main`. An armed-but-unmerged auto-merge
  does block it: `main` has not moved yet.
- The working tree is clean and no merge is in progress.
- The Step 2 "no new stable release" short-circuit is fine to release from — `main` was never
  modified, and the fork may still have unreleased commits of its own.

The release skill requires a checkout whose content is `origin/main`. This run is on `$SYNC_BRANCH`
in a worktree, and `main` is very likely checked out in another worktree, so do not try to check out
the branch. Detach onto the merged tip instead — same content, no branch contention:

```sh
git fetch origin main
git checkout --detach origin/main
```

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

Let the skill run to its end. It watches the build until the GitHub release is published, which
takes over an hour because of mac notarization, and it re-runs, fixes, or recuts within its own
limits when the build fails. Waiting is part of this run, so don't cut it short. The skill also
finishes a previous release that never published, so run it even when this sync changed nothing.

If the release skill stops on one of its own preconditions, or ends in "needs attention", that is a
"needs attention" item, but it does NOT invalidate the sync: the PR is already merged and `main`
already carries it, and that stands. Never try to undo the sync because a release failed, and never
re-invoke the skill in the same run to force a different outcome.

## Step 15 — Record what this run learned

Most runs learn nothing and open no PR here. That is the normal outcome. An empty or padded learning
PR is worse than none: it teaches the next reader to skim the one place that is supposed to be worth
reading.

Two things qualify, and the run must have actually hit them:

- **A wrong turn.** This skill led you somewhere wrong, or said nothing where it should have warned,
  and it cost the run time. Record the check that would have caught it, not the narrative.
- **A confirmed discovery.** A resolution you proved correct that the next run would otherwise
  re-derive — a file that always resolves one way and why, a command whose obvious form is subtly
  wrong against this repo.

Both carry the same bar: **reproducible**. A flaky check, a dropped connection, a one-off
environment quirk is not a lesson, and writing it up as one puts a false rule in front of every
later run.

**Off-limits to any run-authored edit:** the `## Hard safety rules` section, and the "Never, on
either gate" list in the fix policy. Those are what stop a run from buying a green check by
weakening what it checks — and a run that has just been inconvenienced by one is the worst possible
author of its revision. If you believe one is wrong, say so as a "needs attention" item in the
report and leave the text alone.

Where a lesson goes:

- A lesson that is a **rule** — do X, never Y, check Z first — is edited into the step that owns it.
  A rule parked in an appendix is a rule the next run skims past.
- Everything else appends to `references/sync-lessons.md`: what happened, what the correct move was,
  and how to recognize the situation again.

Read what is already written before you add to it. This skill is long and covers a great deal;
restating an existing rule in different words is how a runbook starts contradicting itself. A lesson
that refines an existing rule edits that rule rather than settling in beside it.

Open it from its own branch — never `$SYNC_BRANCH`, which has already merged:

```sh
git fetch origin main
git checkout -b "sync-lessons/${STABLE_TAG}" origin/main
# edit .claude/skills/sync-upstream/** only
git add .claude/skills/sync-upstream/
git commit -m "docs(sync-skill): <what the next run will do differently>"
git push -u origin "sync-lessons/${STABLE_TAG}"
env -u GITHUB_TOKEN gh pr create --repo zpyoung/orca --base main \
  --title "sync-skill: <the lesson in one line>" --body-file <path to the body file>
```

The body carries the evidence: the command that misled you, its output, the SHA it happened at, and
what the edit changes for the next run. A reviewer must be able to check the claim without
reconstructing the run.

**The run merges this PR itself once it qualifies.** Unmerged lessons teach nobody: three sat open
for weeks (#99, #114, #125), and the v1.4.230 run hit #99's problem again. A lesson PR qualifies when
all of these hold:

- `git diff --name-only origin/main...HEAD` lists only paths under `.claude/skills/sync-upstream/`
- no hunk of `git diff origin/main...HEAD` falls inside `## Hard safety rules` or the fix policy's
  "Never, on either gate" list. Any doubt about that means it does not qualify
- the Step 10 wait on it exits `0`, with `fork ownership guard` and `PR checks passed` green on its
  exact head

Then merge it as Step 11 merges the sync PR (`--merge --match-head-commit`). If one does not
qualify, leave it open and name it in the report. Do the same for every earlier run's lesson PR
still open, before opening this one, so the backlog never builds. It blocks nothing either way: the
sync is already merged and any release already dispatched.

Scope is `.claude/skills/sync-upstream/**` and nothing else. A lesson about the release procedure
belongs to the `release` skill: report it, do not edit it from here.

## Step 16 — Report

- Stable target: `$STABLE_TAG` at `$UPSTREAM_TARGET`
- PR: `$PR_URL`, and its end state (`merged` | `open — needs attention` | `auto-merge armed`)
- `origin/main`: old SHA → new SHA, and the resolution used (`no new stable release` |
  `fast-forward` | `clean` | `auto-ours` | `auto-ours+tree` | `not changed`)
- `origin/upstream`: old SHA → new SHA
- Backup ref: `origin/$BACKUP_REF` at `$ORIGIN_MAIN_OLD`
- Fork commits: N, all confirmed still reachable at their original SHAs
- Every path resolved against the manifest, grouped by the list it came from, plus every
  `merge-review.txt` path and what the hand review concluded
- Unreleased upstream work deliberately NOT taken: `git rev-list --count HEAD..upstream/main`.
  Expected to be large; informational only — it is the whole point of tracking stable releases.
- Verification: pass/fail per Step 8 step (install, manifest, typecheck, lint) — tests are reported
  under PR CI below, not here
- PR CI: every check that failed, whether it reproduced on re-run or was flake, and every fix commit
  made to turn it green — SHA, subject, and the cause it addressed
- Release: `nothing to release` | `skipped (<reason>)` | `published <tag>` with the release URL |
  `needs attention` with the release skill's classified cause, plus every run, re-run, recut, and
  fix PR the skill reported
- Learned: `nothing` | the lesson in one line and the URL of the skill PR, merged or left open with
  the Step 15 condition it failed; plus every earlier lesson PR this run merged
- All "needs attention" items

## Hard safety rules

- The sync target is ALWAYS a strict `vX.Y.Z` upstream tag. Never merge an `-rc.N` tag, never merge
  `upstream/main`, never merge a commit picked off `main` as a stand-in for a release. If no new
  stable release exists, the correct action is to change nothing.
- Never push `main` directly. `main` advances only by merging the sync PR, and only with a merge
  commit — `--squash` and `--rebase` are out of scope for the same reason a rebase is.
- Never rewrite `origin/main`. This flow is append-only: merge commits go on top, fork commit SHAs
  never change. Any operation that would rewrite fork history (rebase, filter-branch, amend of an
  existing fork commit) is out of scope.
- Never force-push anything — not `origin/main`, not `origin/upstream`, not any `backup/*` ref.
  There is no force-push in this flow at all.
- Conflict auto-resolution favors the fork only for files the manifest declares. `-X ours` during
  the merge, then Step 6 resolves everything else back to `$UPSTREAM_TARGET`. Tree conflicts are
  limited to the two cases in Step 5. Never hand-edit a conflicted file to invent a merge.
- A fork commit unreachable after the merge is a hard failure, never a warning to push through.
- Tests are PR CI's job, not the local gate's. Never re-add `pnpm test` to Step 8 to "check first",
  and never treat its absence as licence to open a PR from a tree Step 8 rejected.
- A failing gating check (Step 10 defines which are gating) is never tolerated. Re-running one once
  to rule out flake is not tolerating it — a reproduced failure is either fixed under the fix policy
  or escalated with the PR left open, even when it provably pre-dates the sync.
- Never buy a green check by weakening what it checks: no skipped or narrowed tests, no `max-lines`
  disable or baseline bump, no relaxed lint rule, no loosened ownership guard. The fix policy is the
  whole of what a run may do to a red gate.
- On any abort path, leave no in-progress merge (`git merge --abort`) and reset the run branch to
  `$ORIGIN_MAIN_OLD`. The branch and its worktree belong to the caller — never delete them, and
  never touch `main` on the way out.
- Releasing is delegated to the `release` skill, always. Never compute a fork version, edit
  `CHANGELOG.md`, create a tag, or dispatch `release-cut.yml` directly — the skill owns the version
  algebra, and a hand-rolled version can regress the published series and break auto-update.
- Never cut a release from work this run could not verify and land. No release after any hard fail,
  none while the PR is still open, none with a dirty tree.
- One invocation of the release skill per run, at most. The re-runs and the one recut it makes inside
  its own limits are part of that invocation. If it reports "nothing to release", that is the end
  of it.
- This skill is revised by its own runs, but only through Step 15: a separate branch, a PR the run
  merges only when Step 15's conditions all hold, and no edit to `## Hard safety rules` or the fix
  policy's never-list. Never edit the skill on `$SYNC_BRANCH`, and never edit it as a way of getting
  a check green — a rule rewritten to match what a run did is not a lesson, it is a cover-up.
