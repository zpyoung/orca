# Resolving an upstream sync merge

Reference for the `sync-upstream` skill. It covers one half of a sync — which side of the merge
wins, per file, and how to verify that the result holds. The surrounding procedure (resolving the
tag, backing up, pushing, releasing) is in `SKILL.md`, which sends you here at its ownership step
and again at its verification gate.

## Why blanket `-X ours` breaks the build

Upstream cuts a release branch, then cherry-picks fixes and lands reverts **on that branch**. Those
commits never reach `upstream/main`. Every sync pulls them into the fork's `main`, where they are
permanent. Upstream's `main` meanwhile keeps evolving the same code and ships the evolved version in
the next stable tag.

So the fork ends up holding a *stale variant* of upstream code that it never wrote. `-X ours`
defends that variant while taking upstream's new code around it, and the tree stops cohering:
declarations the fork's side deleted, still referenced by upstream's side.

This is not hypothetical and it does not resolve itself. It has hit ai-vault session deletion
(inherited revert vs. upstream's re-landed fixes), the Cmd+J palette (three release-branch
cherry-picks upstream later reworked), and the GitHub client. Each upstream release that touches
code sitting behind an inherited release-branch commit adds another. **A failing sync retried
unchanged fails identically** — the fix is always a policy change, never a re-run.

## The rule

Fork priority is only meaningful for files the fork actually claims, and the claim is declared, not
inferred: `config/fork-ownership.json` — read through `config/scripts/fork-ownership-manifest.mjs`
— is the source of truth. Everything the manifest doesn't claim resolves to the upstream release.

Run this block as one unit, starting from the pre-merge fork tip. If `git merge` stops on
tree conflicts, resolve them before running the commands after it:

```sh
merge_head=$(git rev-parse HEAD)
git merge <target-ref>
node config/scripts/sync-upstream-file-ownership.mjs <target-ref> "$merge_head" <out-dir>
tr '\n' '\0' < <out-dir>/checkout.txt | xargs -0 git checkout <target-ref> --
tr '\n' '\0' < <out-dir>/remove.txt   | xargs -0 git rm -f --ignore-unmatch --
tr '\n' '\0' < <out-dir>/ours.txt     | xargs -0 git checkout "$merge_head" --
```

`ours.txt` must resolve to `$merge_head`, not `HEAD`: a clean (non-conflicted) `git merge` advances
`HEAD` to the new merge commit, so `git checkout HEAD --` would restore the already-merged content
instead of the fork side.

The manifest declares four classes, and the classifier sorts every differing path into the matching
list:

- **`exception`** — a whole-file, fork-side-always-wins claim, written to `ours.txt`. An entry may
  carry `"deleted": true`, meaning the fork deliberately deletes that upstream path; those go to
  `remove.txt` instead, since the fork's intent for the path is removal, not fork-side content.
- **`seam`** — a file that takes a real three-way merge, where only the manifest's declared `lines`
  are a protected footprint. Written to `merge-review.txt`.
- **`feature`** — a fork-owned path matched by a feature glob. Also written to `merge-review.txt`.
- **`upstream`** — unclaimed. Resets to the release: `checkout.txt` if the tag still has the file,
  `remove.txt` if the tag dropped it.

`merge-review.txt` isn't consumed by a shell command: `git merge` already ran a real three-way merge
on every seam and feature path, either auto-resolving disjoint hunks or leaving conflict markers.
Open each listed path and check it by hand against the manifest's declared `lines` for that path —
those lines are the protected floor, not the whole file — before continuing.

Upstream owns every key it defines, so the manifest leaves `src/renderer/src/locales/*.json`
unclaimed and they reset to the tag through `checkout.txt` like any other upstream file. The fork's
own keys live in per-feature bundles under the feature directories, which a feature glob claims. Keep
that split: a fork entry duplicating a key upstream defines shadows upstream's real translation with
the English fallback `sync:localization-catalog` wrote, and that locale silently renders English.

## Tier-2 forked-copy replay

Complete this checklist for **every** copy headed by `FORK-COPY-OF` and `FORK-COPY-SHA` after
ownership resolution and before final verification. Treat the complete output of this command as
the checklist; do not rely on a remembered path list:

```sh
git grep -l '^// FORK-COPY-OF:' -- ':(glob)**/fork-*/**'
```

Cross-check every candidate against `config/fork-ownership.json`: it must be covered by a feature
glob, its first two physical lines must be the two copy headers, and the target tag must not contain
the candidate path. Anything else is an ownership or collision finding to raise before replay.

1. For each copy, set the copy path and new stable tag explicitly. Parse both headers, validate the
   recorded SHA as a full commit ID, and resolve the target tag to a commit before invoking `git`:

   ```sh
   copy_path='path/from-the-git-grep-output'
   target_ref='vX.Y.Z'
   printf '%s\n' "$target_ref" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || exit 2
   first_header=$(sed -n '1p' "$copy_path")
   second_header=$(sed -n '2p' "$copy_path")
   case "$first_header" in '// FORK-COPY-OF: '*) ;; *) exit 2 ;; esac
   case "$second_header" in '// FORK-COPY-SHA: '*) ;; *) exit 2 ;; esac
   recorded_paths=${first_header#// FORK-COPY-OF: }
   recorded_sha=${second_header#// FORK-COPY-SHA: }
   test -n "$recorded_paths" || exit 2
   printf '%s\n' "$recorded_sha" | grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$' || exit 2
   git cat-file -e "${recorded_sha}^{commit}" || exit 2
   target_commit=$(git rev-parse --verify "${target_ref}^{commit}") || exit 2
   if git cat-file -e "${target_commit}:${copy_path}" 2>/dev/null; then exit 2; fi
   status_file=$(mktemp)
   git diff --name-status -z --find-renames "$recorded_sha" "$target_commit" > "$status_file" \
     || { rm -f "$status_file"; exit 2; }
   ```

   For each comma-separated value in `recorded_paths`, set `recorded_path` explicitly and parse the
   NUL-delimited whole-tree snapshot below. Do not pass the old path as a `git diff` pathspec: Git
   filters before rename discovery and loses the replacement. The parser prints a JSON `rename`
   result with the complete new path, a `status` result for `M` or `D`, or nothing when unchanged.

   ```sh
   recorded_path='one/path/from-recorded_paths'
   node - "$status_file" "$recorded_path" <<'NODE'
   const fs = require('node:fs')
   const fields = fs.readFileSync(process.argv[2], 'utf8').split('\0')
   const recordedPath = process.argv[3]
   for (let index = 0; index < fields.length - 1; ) {
     const status = fields[index++]
     const firstPath = fields[index++]
     if (status.startsWith('R')) {
       const resolvedPath = fields[index++]
       if (firstPath === recordedPath) {
         console.log(JSON.stringify({ kind: 'rename', path: resolvedPath }))
       }
     } else if (firstPath === recordedPath) {
       console.log(JSON.stringify({ kind: 'status', status }))
     }
   }
   NODE
   ```

   Repeat the parser for every recorded path, then remove the snapshot with `rm -f "$status_file"`.
   A `D` is not an empty delta: raise it to the user as a collision-policy decision before changing
   the copy or its header. For an unchanged path, retain the path in the list.

2. When a resolved module is materially smaller than its recorded source, inspect the same upstream
   split commit for sibling modules. Add every sibling created by that one-to-many split to the
   resolved path list; rename detection reports only the largest similarity match. Diff the old and
   new commits across **every recorded and resolved path**, then replay that upstream delta into the
   fork copy by hand, resolving interactions with fork behavior deliberately.

   ```sh
   git diff "$recorded_sha" "$target_commit" -- \
     <every-recorded-path> <every-resolved-path>
   ```

3. Only after the hand replay is complete, replace `FORK-COPY-OF` with the complete resolved path
   list and replace `FORK-COPY-SHA` with the value of `target_commit`. Update both header fields together,
   including when a path was unchanged; never advance only the SHA or leave an old path behind.

## Tier-4 pending-upstream review

For every manifest `exceptions[]` entry whose `status` is `pending-upstream`, follow its `ledger`
target in `docs/fork-upstreaming.md`, confirm that the target still exists, and review upstream
movement over the old-to-new stable-tag range for that item. Keep its manifest and ledger state
atomic by creating, updating, or removing the matching entries in the same change. Do not let a
resolved, declined, or moved upstream item leave a stale manifest row or an orphaned ledger entry.

## Upstream feature-collision review

For every manifest `features[]` entry, compare its `purpose` with upstream release notes and the
changelog for the old-to-new stable-tag range. Record exactly one outcome per feature: `none`,
`possible`, or `confirmed`. Raise every `possible` or `confirmed` outcome to the user for a
decision. Never silently delete a fork feature or reconcile it with an upstream implementation;
apply any removal, archival, or reconciliation only after that decision.

## When upstream's own release does not compile

Upstream's release branches suffer the same cherry-pick incoherence. v1.4.180 shipped
`src/main/github/client.test.ts` using `setPRCommentReaction` with neither the implementation nor
the import — both exist on `upstream/main`, only the usage hunk reached the release branch. The same
tag also shipped an `AgentKanbanBoard` assertion for a Japanese label its own catalog does not
contain.

Prove it against the pristine tag before blaming the merge:

```sh
git checkout --detach <target-ref> && pnpm vitest run --config config/vitest.config.ts <file>
```

If it fails there too, keeping the fork's version of that file, dropping a test for functionality
the release omits, or aligning an assertion with what the release actually renders is in scope — say
which and why in the commit message. Do **not** backport the missing implementation from
`upstream/main`: taking unreleased trunk code is exactly what syncing stable tags exists to avoid.

## When upstream tightens the linter

A stable tag can enable new rules in `.oxlintrc.json` (and bump the `oxlint` devDependency). Those
rules then fire on **fork-only files the merge never touched**, byte-identical to the pre-merge
baseline. This is not an ownership question — there is no upstream side of a fork-only file to
resolve to — and it blocked three consecutive syncs (v1.4.183 twice, v1.4.184) before the policy
below existed.

Diagnose it before treating a lint failure as merge damage:

```sh
git diff "$ORIGIN_MAIN_OLD" HEAD -- .oxlintrc.json     # did the merge add rules?
git diff --quiet "$ORIGIN_MAIN_OLD" -- <violating-file> # is the file identical to baseline?
```

Both true → toolchain tightening. **Adopting the new rule in the fork's own file is in scope**, but
only mechanically:

```sh
pnpm exec oxlint --fix <violating-file>
```

Commit it separately from the merge and the ownership commit, and name the rule in the message. Then
re-run the full gate — the fix is only valid if typecheck, lint, and tests all still pass.

Hard limits. Violate any of these and it is a human decision, not an automated one:

- Only files byte-identical to `$ORIGIN_MAIN_OLD`. A violation in a file the merge *changed* is
  `-X ours` damage — resolve it to one real side instead (see the two sections above).
- Only what `--fix` rewrites on its own. Never hand-write a logic change to satisfy a rule, and never
  reach for `--fix-suggestions` or `--fix-dangerously`; both can alter behavior.
- Never edit `.oxlintrc.json` to silence the rule. Upstream owns that file, so the next sync would
  re-add the rule and re-block.

Only violations that survive into the **merged** tree matter. Running the new config against the
pre-merge baseline over-reports badly: most flagged files take upstream's already-compliant version
in the merge. Use the merged tree's `pnpm lint` output as the authoritative list.

To get ahead of the next release instead of discovering this mid-sync, run the target's config
against the current tree before merging — restore the baseline config afterward:

```sh
cp .oxlintrc.json /tmp/oxlintrc.baseline.json
git show <target-ref>:.oxlintrc.json > .oxlintrc.json
pnpm exec oxlint; cp /tmp/oxlintrc.baseline.json .oxlintrc.json
```

## When upstream ratchets a chokepoint

The same shape reaches the fork through tests rather than the linter, and the local gate cannot see
it at all. Upstream routes a whole class of call onto one module, then pins it with a boundary test
that scans every source file and asserts the offender list is empty and its count has not grown.
v1.4.190 did this twice — `runWslProcess` for `wsl.exe` and `runProcess`/`spawnProcess` for child
processes — and the fork's one non-conforming file failed five checks from that single cause.

The tell is a boundary or ratchet test naming a `fork-*` path in its diff, e.g.
`expected [ Array(1) ] to deeply equal []` with a fork file as the only received element. Read the
detector to see what it matches before changing anything: it may key on a string literal, so a
doc comment mentioning the binary can be a false positive, and it may mask calls that already pin
the right option.

Migrating the fork file is in scope and is the whole fix — never allowlist a fork path to quiet the
ratchet. Take the idiom from the upstream sibling the fork file was modelled on, which upstream
migrated in the same release, and carry every option it pins across; a payload authored for bash
must keep saying so, because the new runner's default interpreter is usually `sh`.

Two follow-on effects are easy to miss. A fork file that bypasses the new chokepoint also bypasses
the **mock** in upstream's own tests, so an upstream test can fail with a parse error far from the
fork — the fork's direct call skipped a queued mock response and the next consumer read the wrong
frame. And the fork's own tests mock whatever the fork used to call, so they have to move to the new
module too.

## Verifying

Two manifest checks run against the new release, and the second one is where a sync goes quietly
wrong:

```sh
node config/scripts/sync-upstream-file-ownership.mjs --verify-seams
node config/scripts/sync-upstream-file-ownership.mjs --verify-residuals <target-ref>
```

`--verify-seams` asserts each declared line is still present. That is a one-way tripwire: it cannot
see an undeclared edit, and it cannot represent a deletion at all, because a removed upstream line
has no line to declare. `--verify-residuals` compares each seam file's whole added/removed footprint
against the budget recorded in `residuals`, so both of those become visible.

A drifted budget is a question, not a formality. A budget that *shrank* usually means the release
absorbed a line the fork was carrying, and the seam should be re-read before the number is updated.
Re-baseline by rerunning the recorder and committing the new numbers with the resolution, never as a
sweep to make the check quiet.

`pnpm typecheck` and `pnpm lint` are absolute: a failure is a failure. Neither is run against a
baseline for comparison, and there is nothing to compare against — the tree either compiles and
lints or it does not.

The gate does **not** run the test suite. Vitest cannot run on this machine, and the remote host it
would run on reports failures the code did not cause. `SKILL.md` § Step 8 has the reasoning; the
short version is that PR CI runs the same suite on clean hosted runners as a required check, so the
sync PR is where a test failure is found and fixed.

The one exception to lint being absolute is the rule-tightening case above, and it is an exception
about *how the tree is fixed*, not about tolerating a failure: lint must still pass before the push.

Traps that fake results:

- `rm -f config/*.tsbuildinfo` before every typecheck. Composite projects cache errors across
  `git checkout` swaps.
- Running the suite locally to diagnose something is a deliberate detour, not part of the gate — and
  it goes through `pnpm test:sandbox` (`AGENTS.md`), which a `PreToolUse` hook enforces. Two traps
  bite whichever way it is invoked: the run never builds the CLI, and ambient Git configuration can
  alter fixture commits. Build the CLI first, then replace global/system config with one controlled
  empty file while also stripping every inherited Git-config environment channel:

  ```sh
  empty_git_config=$(mktemp)
  trap 'rm -f "$empty_git_config"' EXIT
  pnpm build:cli && env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_KEY_1 \
    -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_VALUE_1 -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM \
    -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_NOSYSTEM \
    GIT_CONFIG_GLOBAL="$empty_git_config" GIT_CONFIG_SYSTEM="$empty_git_config" \
    GIT_CONFIG_NOSYSTEM=1 pnpm test
  ```

- `.gitignore` excludes `/.claude/skills/*` so machine-local skill installs stay out of the repo.
  Fork-owned skills are re-included by name. A new skill directory needs its own `!` line, and every
  file in it needs an `exceptions` entry in `config/fork-ownership.json` or the ownership guard fails
  the PR on coverage.
