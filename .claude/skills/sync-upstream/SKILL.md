---
name: sync-upstream
description: Use when resolving an upstream sync merge in the zpyoung/orca fork — deciding which side wins per file after merging an upstream stable tag. Explains why blanket -X ours produces trees that do not compile, and how to resolve upstream-owned files back to the release. Triggers on "sync upstream", "merge the stable tag", "sync failed", "typecheck fails after the merge".
---

# Resolving an upstream sync merge

`zpyoung/orca` consumes upstream **stable tags** (`vX.Y.Z`), never `upstream/main`. This skill
covers only the conflict-resolution half of a sync: which side of the merge wins, per file. The
surrounding procedure — resolving the tag, backing up, pushing, releasing — lives in the sync
automation prompt.

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

After the merge and its tree-conflict resolution:

```sh
merge_head=$(git rev-parse HEAD)
git merge <target-ref>
node config/scripts/sync-upstream-file-ownership.mjs <target-ref> "$merge_head" <out-dir>
tr '\n' '\0' < <out-dir>/checkout.txt | xargs -0 git checkout <target-ref> --
tr '\n' '\0' < <out-dir>/remove.txt   | xargs -0 git rm -f --ignore-unmatch --
tr '\n' '\0' < <out-dir>/ours.txt     | xargs -0 git checkout "$merge_head" --
node config/scripts/sync-upstream-locale-catalogs.mjs <target-ref>
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

Locale catalogs get their own pass because upstream owns every key it defines. The fork's catalogs
carry English fallbacks written by `sync:localization-catalog`; a fork-wins merge lets those shadow
upstream's real translations and non-English locales silently revert to English. The fork keeps only
keys upstream has no opinion on.

## Tier-2 forked-copy replay

Complete this checklist for **every** copy headed by `FORK-COPY-OF` and `FORK-COPY-SHA` after
ownership resolution and before final verification. Treat the complete output of this command as
the checklist; do not rely on a remembered path list:

```sh
git grep -l '^// FORK-COPY-OF:'
```

1. Read the recorded SHA and every path in the comma-separated `FORK-COPY-OF` list. For each
   recorded path, discover renames across the **whole tree** before filtering the result. Do not
   pass an old path as a `git diff` pathspec: Git filters before rename discovery and loses the
   replacement.

   ```sh
   git diff --name-status --find-renames "$recorded_sha" "$target_ref" \
     | awk -v p="$recorded_path" '$1 ~ /^R/ && $2 == p { print $3 }'
   ```

   If no rename resolves the path, classify it with another unfiltered status lookup:

   ```sh
   git diff --name-status --find-renames "$recorded_sha" "$target_ref" \
     | awk -v p="$recorded_path" '$2 == p { print $1 }'
   ```

   `M` means it remains at the recorded path; `D` means upstream deleted it; and no status means it
   is unchanged. A `D` is not an empty delta: raise it to the user as a collision-policy decision
   before changing the copy or its header. For an unchanged path, retain the path in the list.

2. When a resolved module is materially smaller than its recorded source, inspect the same upstream
   split commit for sibling modules. Add every sibling created by that one-to-many split to the
   resolved path list; rename detection reports only the largest similarity match. Diff the old and
   new tags across **every recorded and resolved path**, then replay that upstream delta into the
   fork copy by hand, resolving interactions with fork behavior deliberately.

   ```sh
   git diff "$recorded_sha" "$target_ref" -- \
     <every-recorded-path> <every-resolved-path>
   ```

3. Only after the hand replay is complete, replace `FORK-COPY-OF` with the complete resolved path
   list and replace `FORK-COPY-SHA` with the synced tag commit. Update both header fields together,
   including when a path was unchanged; never advance only the SHA or leave an old path behind.

## Tier-4 pending-upstream review

For every manifest `exceptions[]` entry whose `status` is `pending-upstream`, follow its `ledger`
target in `docs/fork-upstreaming.md`, confirm that the target still exists, and review upstream
movement over the old-to-new stable-tag range for that item. Keep its manifest and ledger state
atomic by creating, updating, or removing the matching entries in the same change. Do not let a
resolved, declined, or moved upstream item
leave a stale manifest row or an orphaned ledger entry.

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

## Verifying

`pnpm typecheck` and `pnpm lint` are absolute — no baseline differential. `pnpm test` is
baseline-differential: a failure counts only if the same test passes at the pre-merge SHA.

The one exception to lint being absolute is the rule-tightening case above, and it is an exception
about *how the tree is fixed*, not about tolerating a failure: lint must still pass before the push.

Traps that fake results:

- `rm -f config/*.tsbuildinfo` before every typecheck. Composite projects cache errors across
  `git checkout` swaps.
- `pnpm test` never builds the CLI, and the harness injects `GIT_CONFIG_*` that deterministically
  fails the relay tests. Build the CLI before the suite and strip every ambient Git-config variable:

  ```sh
  pnpm build:cli && env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_KEY_1 \
    -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_VALUE_1 -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM pnpm test
  ```

- `.claude/skills/*` is gitignored. New skills here need `git add -f` or they never reach the host
  the automation runs on.
