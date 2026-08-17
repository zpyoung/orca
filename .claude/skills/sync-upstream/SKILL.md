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

Fork priority is only meaningful for files the fork actually changed. Everything else resolves to
the upstream release.

After the `-X ours` merge and its tree-conflict resolution:

```sh
node config/scripts/sync-upstream-file-ownership.mjs <target-ref> <merge-head> <out-dir>
tr '\n' '\0' < <out-dir>/checkout.txt | xargs -0 git checkout <target-ref> --
tr '\n' '\0' < <out-dir>/remove.txt   | xargs -0 git rm -f --ignore-unmatch
node config/scripts/sync-upstream-locale-catalogs.mjs <target-ref>
```

A file is **fork-owned** when a fork-authored commit touched it, plus three corrections the resolver
already encodes:

- **`package.json`** — its version line is fork-owned but written by `github-actions[bot]`, so
  authorship alone hands the file to upstream and regresses the published version series.
- **The fork's app identity** — `com.zpyoung.orca` lives in `local-build-compatibility-contract.*`
  and its tests, which no fork-authored *non-merge* commit touched. Resetting them to upstream
  breaks the packaged-identity contract.
- **A test whose subject the fork owns** stays on the fork's version. Upstream's newer test asserts
  against upstream's implementation, which this tree deliberately does not carry. The resolver finds
  these by resolving the test's relative imports, ignoring `src/shared/types.ts` and
  `constants.ts` — the fork appends to those barrels, and importing a type from one is not
  behavioral coupling.

And one deliberate exception in the other direction:

- **`resources/skills/*.json`** resolve to upstream. The fork's snapshot history cannot be
  reconciled with upstream's newer skill content: the append-only guard rejects it and
  `generate:skill-bundle-manifest` cannot repair it.

Locale catalogs get their own pass because upstream owns every key it defines. The fork's catalogs
carry English fallbacks written by `sync:localization-catalog`; a fork-wins merge lets those shadow
upstream's real translations and non-English locales silently revert to English. The fork keeps only
keys upstream has no opinion on.

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
  fails the relay tests. Run `pnpm build:cli` first, then the suite with those variables unset.
- `.claude/skills/*` is gitignored. New skills here need `git add -f` or they never reach the host
  the automation runs on.
