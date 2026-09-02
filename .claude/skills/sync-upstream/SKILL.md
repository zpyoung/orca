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
latitude: an unattended run stops and reports wherever an attended run would ask a human, and the
decisions this skill routes to a human stay routed to a human.

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

- If `git merge-base --is-ancestor "$UPSTREAM_TARGET" origin/main` succeeds, `main` already contains
  this release. Skip to Step 12 and note "no new stable release (already at $STABLE_TAG)". This is
  the expected outcome on most days and is a success, not a warning.
- If N is 0 and `git merge-base --is-ancestor origin/main "$UPSTREAM_TARGET"` succeeds, this is a
  plain fast-forward — the fork has no commits of its own to defend. Record
  `resolution=fast-forward`, do Step 4, then set the run branch to the tag
  (`git reset --hard "$UPSTREAM_TARGET"`) and skip to Step 8. It still lands through a PR; there is
  no direct push to `main` anywhere in this flow.
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

## Step 4 — Confirm the run workspace

The caller supplies the workspace: a fresh worktree on a disposable branch. Verify what you were
handed and stop rather than adapting to a workspace that fails any of these:

- `git symbolic-ref --short HEAD` resolves (HEAD is not detached) and is **not** `main`. Merging on
  `main` would put the resolution on the branch the PR targets.
- `git status --porcelain` is empty.
- No rebase/merge/cherry-pick is in progress (no `.git/rebase-merge`, `.git/rebase-apply`,
  `.git/MERGE_HEAD`).
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

If any check or the install fails, STOP and go to Step 13 with "needs attention: unusable run
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
  fork's file: `git checkout --ours -- <path>` then `git add <path>`.
- **"deleted by us / modified by them"** (the fork deleted it, upstream modified it) → honor the
  fork's deletion: `git rm -f <path>`.

Then `git commit --no-edit --no-verify`. Record `resolution=auto-ours+tree` and log every path
touched with the rule applied. `--no-verify` is required, not a shortcut: husky's pre-commit hook
runs `oxlint` over the staged tree, and the `-X ours` tree is exactly the tree Step 6 exists to
repair — it routinely carries a duplicate declaration or a broken brace pair, so the hook rejects
the merge commit and lint-staged reverts your resolution. Step 8 is this run's lint gate, and it
runs on the repaired tree.

Anything else — rename/rename, rename/delete, submodule conflicts, binary files you cannot attribute
to a side, or more than 25 conflicted paths in total — is out of scope. Do not guess. Run
`git merge --abort` and go to Step 13 with "needs attention: merge conflicts require manual
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
`--unattended`, that is a stopping condition: go to Step 13 with "needs attention: <the decision>"
rather than choosing a side.

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

A `reason` that reads like whole-file ownership ("the fork's release-tooling delta", "fork-specific
thresholds") is exactly where this goes wrong: it is describing a *delta*, and the exception is
keeping the whole file. v1.4.194 lost four that way — the Electron installer's staging-transaction
rework, the packaged-runtime contract's move off `package.json`'s `pnpm` block, release-cut's new
permission row, and `pr.yml`'s new real-IME lane. Every one passed both manifest checks, the local
gate, and the ownership guard, and every one failed in PR CI instead.

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

`package.json` is the one that fails loudest and least obviously: `pnpm-lock.yaml` is upstream-owned
and resolves to the tag, so a dependency the exception dropped makes `pnpm install --frozen-lockfile`
fail in Step 8 with a lockfile error that names nothing about ownership.

**A reset upstream test may pin an upstream release tag this remote does not have.** The
cross-version-wire harness resolves refs against git, so a constant naming a bare `vX.Y.Z` aborts
the whole suite in PR CI — three releases have now added one. Sweep after the reset:

```sh
git grep -nE "'v[0-9]+\.[0-9]+\.[0-9]+'" -- tests/e2e/cross-version-wire/
```

A hit only matters where the string reaches `materializeReleaseCheckout`; fixture inputs to
`selectLatestStableReleaseTag` are pure and stay as they are. For a real one, pick the fork release
that contains that upstream tag and nothing newer (`merge-base --is-ancestor` both ways), prove the
modules the harness loads are byte-identical across the two, repoint the constant, and declare it as
a seam beside its siblings.

Commit the ownership resolution as a single follow-up commit on top of the merge, again with
`--no-verify` for the reason in Step 5; Step 7 expects exactly one such extra commit.

If the classifier fails, or `checkout.txt` is empty when the merge was not a no-op, STOP and go to
Step 13 with "needs attention: ownership resolution failed". Do not fall back to plain `-X ours` —
that is the known-broken state.

## Step 7 — Commit accounting

Merging never replays fork commits, so unlike a rebase it cannot silently drop or rewrite them. That
makes this check strict and cheap: every SHA in FORK_COMMITS must still be present and reachable.

For each SHA recorded in Step 2, `git merge-base --is-ancestor <sha> HEAD` must succeed. If any does
not, something rewrote history — reset back (`git reset --hard $ORIGIN_MAIN_OLD`) and go to
Step 13 with "needs attention: fork commit <sha> <subject> is no longer reachable after merge".

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
- apply mechanical lint/format fixes (`oxlint --fix`, `pnpm format`), committed on their own

Escalate — stop, leave the PR open, report "needs attention" — for:

- any resolution that would cost fork feature functionality: upstream reworked the code a fork
  feature hangs off, and every fix available loses behavior this fork ships
- the Step 6 human decisions (feature collision, pending-upstream item, unresolvable conflict)
- an upstream defect the fork would have to work around

Never, on either gate:

- skip, delete, or narrow a test to make it pass
- add a `max-lines` disable or a per-file baseline bump — `AGENTS.md` forbids it outright
- weaken a lint rule, the fork ownership guard, or any other CI gate
- wave a failure through as unrelated. A red check is red until a re-run clears it or a fix turns it
  green; "probably pre-existing" is a thing to prove in Step 10, not a reason to move on

Each fix is its own commit, its message naming what broke and why the fix is the right one. Every
fix commit appears in the Step 16 report.

## Step 8 — Verification gate

This gate is the cheap, local half of verification. It proves the tree coheres before a PR exists;
**PR CI owns the test suite** (Step 10). Do not run `pnpm test` here — see below.

Run the gate exactly as [`references/file-ownership.md`](./references/file-ownership.md) § Verifying
specifies, including the manifest checks (`--verify-seams`, `--verify-residuals`) and clearing
`config/*.tsbuildinfo` before every typecheck. Those are not hygiene; each one deterministically
fakes a result if skipped.

Order: `pnpm install --frozen-lockfile` (re-run it here — the merge may have taken upstream's
`pnpm-lock.yaml`) → manifest checks → `pnpm typecheck` → `pnpm lint`.

Every step is absolute: stop at the first failure and treat it as a hard fail. The reference's
rule-tightening carve-out is the one exception, and it is an exception about *how the tree is
fixed*, not about tolerating a failure — lint must still pass before the push, and the mechanical
`oxlint --fix` it permits is committed separately from the merge and the ownership commit.

**Why no tests here.** Vitest cannot run on the machine this skill runs on; `AGENTS.md` routes every
local run through a remote Docker host, and that host is a single shared box. Sharded across it the
suite reports failures the code did not cause — timeouts, perf budgets, and temp-file races that
land on a different random subset each run and clear the moment the same files run alone. Chasing
them costs the run an hour and answers a question PR CI answers properly: the `test` matrix in
`.github/workflows/pr.yml` runs the same suite on clean hosted runners, sharded 16 ways across two
Node versions, and it is a required check for `verify`. A local pass never authorized a merge, and a
local failure was never trustworthy on its own — so the local run buys nothing the PR does not.

A hard fail here is not the end of the run — work it under the fix policy above, then re-run the
gate from the top. Re-run it whole: a fix for a typecheck error routinely breaks lint, and a partial
re-run is how a broken tree reaches the PR.

If the policy says escalate, or the same failure survives your fixes, restore and bail:
`git reset --hard $ORIGIN_MAIN_OLD`, then go to Step 13 with "needs attention: merge resolved but
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

Record `PR_NUMBER` and `PR_URL`. If a PR already exists for this branch, reuse it
(`env -u GITHUB_TOKEN gh pr view "$SYNC_BRANCH" --repo zpyoung/orca --json number,url`) instead of
opening a second one.

## Step 10 — Drive the PR green

The run owns this PR until every required check passes or the budget runs out. The budget is
**4 hours** from PR creation; compute the deadline once and honor it.

Poll the rollup rather than the web UI, at roughly two-minute intervals — `gh` shares the account's
API rate limit, so do not tighten that:

```sh
env -u GITHUB_TOKEN gh pr view "$PR_NUMBER" --repo zpyoung/orca \
  --json statusCheckRollup,mergeStateStatus,mergeable
```

Wait between polls with a background wait or a monitor, never a foreground `sleep`.

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

Stop and report "needs attention", PR left open, nothing merged, when: the policy says escalate, the
same check fails after a fix aimed at it, or the deadline passes. Name the check, link the run, and
state what you tried.

## Step 11 — Merge the PR

Only when every required check is green.

```sh
env -u GITHUB_TOKEN gh pr merge "$PR_NUMBER" --repo zpyoung/orca --merge
```

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
```

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

Dispatch only — do NOT wait for the build. `release-cut.yml` tags, builds, and publishes; mac
notarization alone runs over an hour. Record the dispatched run and stop.

If the release skill stops on one of its own preconditions or fails partway, that is a "needs
attention" item, but it does NOT invalidate the sync: the PR is already merged and `main` already
carries it, and that stands. Never try to undo the sync because a release failed, and never re-run the skill in the
same run to force a different outcome.

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
git commit -am "docs(sync-skill): <what the next run will do differently>"
git push -u origin "sync-lessons/${STABLE_TAG}"
env -u GITHUB_TOKEN gh pr create --repo zpyoung/orca --base main \
  --title "sync-skill: <the lesson in one line>" --body-file <path to the body file>
```

The body carries the evidence: the command that misled you, its output, the SHA it happened at, and
what the edit changes for the next run. A reviewer must be able to check the claim without
reconstructing the run.

**This PR is never auto-merged and never merged by the run.** Leave it open and name it in the
report. It blocks nothing — the sync is already merged and any release already dispatched.

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
- Release: `nothing to release` | `skipped (<reason>)` | the tag cut and the run dispatched
- Learned: `nothing` | the lesson in one line and the URL of the skill PR left open for review
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
- A failing check is never tolerated. Re-running one once to rule out flake is not tolerating it — a
  reproduced failure is either fixed under the fix policy or escalated with the PR left open, even
  when it provably pre-dates the sync.
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
- One release per run, at most. If the skill reports "nothing to release", that is the end of it.
- This skill is revised by its own runs, but only through Step 15: a separate branch, a PR the run
  never merges, and no edit to `## Hard safety rules` or the fix policy's never-list. Never edit the
  skill on `$SYNC_BRANCH`, and never edit it as a way of getting a check green — a rule rewritten to
  match what a run did is not a lesson, it is a cover-up.
