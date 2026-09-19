# What past sync runs learned

Written by the sync runs themselves, under Step 15 of [`../SKILL.md`](../SKILL.md). Read it before
Step 4.

Everything here was paid for once already — a run took a wrong turn, or proved a resolution correct
that is not obvious from the code. Entries are appended newest last and are never rewritten to look
tidier; a lesson that turns out to be wrong is corrected in place with a note saying so.

A lesson that is a **rule** does not live here. Rules are edited into the step that owns them, where
the next run will actually read them. This file holds what does not reduce to a rule: a situation to
recognize, a resolution and why it was right, a failure mode and its tell.

Each entry carries:

- **What happened** — the observable, at the tag it happened on
- **The tell** — how to recognize the same situation next time, ideally a command and its output
- **The right move** — what the run should do, and what it must not mistake this for

## A release that dissolves a monolith into modules

**What happened.** v1.4.190 (`eb1792985f`, #15172) replaced `src/main/ipc/pty.ts` — 8,030 lines —
with a 39-line barrel re-exporting 73 new modules under `src/main/ipc/pty/`. The fork carried a
96-line `terminal-dock` seam inside that file. `-X ours` kept the fork's whole 8,112-line monolith
*and* the merge added all 73 new modules, so two complete implementations were live at once, each
with its own module state. Nothing complained: the merge was conflict-free after `-X ours`,
`--verify-seams` passed 388/388 because the stale monolith still contained every declared line, and
`pnpm typecheck` was clean. This is the third such release (v1.4.186 and v1.4.187 were the others),
so expect a fourth.

**The tell.** `--verify-residuals` is the only check that sees it, and the drift is not subtle:

```
src/main/ipc/pty.ts: recorded +96/-1, measured +8111/-38
```

A residual measured in thousands means the tag replaced the file with a barrel, not that the fork
grew. Confirm with a line count — `git show "${UPSTREAM_TARGET}:<path>" | wc -l` against the
worktree copy — and list what replaced it with
`git ls-tree -r --name-only "$UPSTREAM_TARGET" -- <path-without-.ts>/`.

**Do not read "thousands" as the threshold.** v1.4.202 moved every RPC param schema into
`src/shared/rpc-contract/*-params.ts` and left four `src/main/runtime/rpc/methods/*-schemas.ts`
files as re-export barrels — 241 lines down to 8, 229 to 14, 215 to 18. The drifts were
`+249/-5`, `+278/-14`, `+216/-18`: hundreds, not thousands, and a fork feature that genuinely
grew a seam file could plausibly show the same number. The line count is what decides, so run it
on **every** drifted seam rather than only the ones with an eye-catching residual:

```sh
while IFS= read -r p; do
  printf '%-70s tag=%-6s fork=%-6s now=%s\n' "$p" \
    "$(git show "${UPSTREAM_TARGET}:$p" 2>/dev/null | wc -l | tr -d ' ')" \
    "$(git show "${MERGE_HEAD_PRE}:$p" 2>/dev/null | wc -l | tr -d ' ')" \
    "$(wc -l < "$p" | tr -d ' ')"
done < <drifted-paths>
```

`tag` far below `fork` is a split. And `now` **above** `fork` is its own finding: the merge took
upstream's additions but not its deletions, so the file now holds both implementations.
v1.4.202 did that to `NativeChatToolRun.tsx` (tag 348, fork 462, merged 467, residual `+119/-0`)
and `TerminalContextMenu.tsx` (355 / 383 / 473). Both are repaired the same way as a split:
`git checkout "$UPSTREAM_TARGET" -- <path>`, then replay the fork delta onto the tag.

Two adjacent tells worth knowing. A seam path that no longer exists in the tag at all is the same
situation one step further along; compare the manifest's seam paths against
`git ls-tree -r --name-only "$UPSTREAM_TARGET"` as sets — in Python, or with `LC_ALL=C` on both the
`sort`s *and* the `comm`. Under the default macOS locale `comm` reports paths as missing that the
tag plainly contains; v1.4.195 got 120 false positives that way, against a true answer of zero. And
a residual that drifts by exactly one or two lines is *not* this — that is ordinary `-X ours` hunk
damage, where upstream added a parameter or an import the fork's side discarded, and it is repaired
in place.

**The right move.** Re-home the seam, do not defend the monolith:

1. Recover the fork's real footprint by diffing the pre-merge fork tip against the **previous** tag
   (`git diff -U6 "$PREV_TAG" "$MERGE_HEAD_PRE" -- <path>`). The recorded residual tells you how
   many lines to expect, so a much larger diff means you have the wrong base.
2. Find where each hunk's surrounding upstream code now lives — grep the new directory for the
   identifiers the fork's hunks sit next to, not for the fork's own names.
3. Apply each hunk to its new home, then `git checkout "$UPSTREAM_TARGET" -- <the monolith path>` so
   the barrel is restored exactly.
4. Repoint `seams` and `residuals` in the manifest **together**, in one edit. One old entry usually
   becomes several, and each new file needs its own declared lines and its own measured budget.

Two things to check afterwards that the manifest checks will not tell you. Consumers on the other
side of the process boundary — preload, renderer — are often untouched by a main-process split, so
verify rather than assume they need editing. And `config/max-lines-baseline.txt` will still carry an
`inline` entry for the retired monolith; `pnpm lint` reports it as a stale baseline entry and
`node config/scripts/check-max-lines-ratchet.mjs --prune` is the fix.

**Do not** edit `config/fork-ownership.json` with a JSON round-trip. `json.dumps` re-expands the
short inline arrays the repo's formatter keeps on one line, turning a 30-line edit into a
650-line diff that buries the actual change. Edit the file as text.

## A later release can invalidate a `deleted: true` exception

**What happened.** The fork deletes 25 upstream paths outright, eleven of them the native-chat
composer modules its own `fork-agent-composer` superseded. Those deletions were decided against
v1.4.198's import graph. v1.4.200 then added four brand-new upstream files —
`NativeChatPromptEditor.tsx` and its test, `native-chat-composer-drop-scope.test.tsx`,
`use-native-chat-composer-catalog.test.tsx` — that import four of the deleted modules
(`native-chat-draft-cache`, `native-chat-composer-scope-cache`, `NativeChatImageAttachmentPreview`,
`use-native-chat-composer-keydown`). Ownership resolution is silent about it: `remove.txt` honours
the deletion, `--verify-seams` and `--verify-residuals` both pass, and the fork ownership guard
passes. It surfaces only as `TS2307: Cannot find module` — reported against *upstream's* files, in a
directory the fork never edited, which reads at first like merge damage somewhere else entirely.

**The tell.** A typecheck error naming a path the fork does not own, pointing at a relative import
of a path that is in `remove.txt`. Confirm with a set comparison rather than by reading the error:

```sh
python3 - "$UPSTREAM_TARGET" <<'PY'
import json, subprocess, sys
m = json.load(open('config/fork-ownership.json'))
gone = {e['path'] for e in m['exceptions'] if e.get('deleted')}
tag = sys.argv[1]
for p in sorted(gone):
    mod = p.rsplit('/', 1)[-1].rsplit('.', 1)[0]
    hits = subprocess.run(['git', 'grep', '-l', f"/{mod}'", tag, '--', p.rsplit('/', 1)[0]],
                          capture_output=True, text=True).stdout.split()
    live = [h.split(':', 1)[1] for h in hits if h.split(':', 1)[1] not in gone]
    if live:
        print(f'{p} still imported by {len(live)}: {live[:3]}')
PY
```

Run it right after `remove.txt` is applied, not after the typecheck fails — the classifier will
never raise it, because a deletion the manifest declares is, to the classifier, resolved.

**The right move.** Withdraw the deletion; do not extend it. Restore the module (and its test) from
the tag, drop the `deleted: true` exception, and leave every fork replacement exactly where it is.
Nothing the fork ships changes: its own field, caches, and copies stay, and the restored upstream
module is simply live again for upstream's own consumers. v1.4.200 needed eight withdrawals (four
modules plus their tests) and cost the fork nothing.

Two adjacent moves are wrong, and both look tempting:

- **Do not delete the new upstream files too.** That is a growing deletion set the fork has to
  re-extend every release, and it throws away upstream tests — `use-native-chat-composer-catalog.test.tsx`
  covers a hook the fork's own composer now calls.
- **Do not repoint upstream's import at the fork's replacement** unless the fork module genuinely
  provides the same surface. The fork's `agent-composer-draft-cache` exports a *string* cache;
  v1.4.200's editor needs `readNativeChatDraftDocument`/`writeNativeChatDraftDocument`, which persist
  a ProseMirror document the fork's cache has no notion of. A type-only import is the exception —
  `NativeChatImageAttachmentPreview` takes the fork's attachment type through an ordinary
  import-swap seam, because the fork really does own that type now.

**Do not mistake this for a feature collision.** Upstream re-landing work beside a fork feature is
not upstream re-implementing it. Record the collision outcome (`agent-composer: possible` here), raise
it, and keep resolving: the withdrawal costs no fork behaviour, so it is not a decision that has to
wait for a human.

## A type-level CI gate whose failure names nothing

**What happened.** v1.4.202 added `src/main/runtime/rpc/rpc-params-type-parity.ts`: a compile-time
assertion that every registered RPC method's handler params match the generated shared catalog.
Two things about it bite a fork at once.

Fork-only methods (`ask.*`, `ledger.*`, the artifact-password methods) have no shared-contract
schema, so they land in the generated `RPC_METHODS_WITHOUT_SHARED_PARAMS` array — but the gate
reads a **hand-written** union, `UncataloguedMethod`, that lists only upstream's own three. That
part is obvious once read.

The second is not. The gate reads each method's **literal** `name` off the registry tuple, and a
fork helper that wraps a method array erases those literals. `withArtifactProtectionProjection`
was declared `<TMethod extends ProjectableMethod>(methods: readonly TMethod[]): readonly TMethod[]`
with `ProjectableMethod = { name: string; … }`. That constraint widens `name` to `string` at the
inference site, so `ARTIFACT_METHODS[number]['name']` became `string` and the whole assertion
collapsed to:

```
src/main/runtime/rpc/rpc-params-type-parity.ts(44,47): error TS2344:
  Type 'string' does not satisfy the constraint 'never'.
```

No method name, no file but the gate's own, and the line it points at is the assertion rather than
the cause. `const` type parameters do not fix it, and neither does a variadic `readonly [...T]`
tuple — the constraint is what widens, so it has to go.

**The tell.** `Type 'string' does not satisfy the constraint 'never'` from a type-only gate.
`string` there means some registered member widened; a genuine gap prints the offending names as a
union instead. Find which array widened with a generated probe rather than by reading code —
it takes one typecheck:

```sh
python3 - <<'PY' > src/main/runtime/rpc/__probe.ts
import re
src = open('src/main/runtime/rpc/methods/index.ts').read()
imps = re.findall(r"^import \{ ([A-Z0-9_]+) \} from '(\./[^']+)'", src, flags=re.M)
print("import type { RpcMethodName } from '../../../shared/rpc-contract/rpc-params-catalog.generated'")
for name, mod in imps:
    print(f"import {{ {name} }} from './methods/{mod[2:]}'")
for i, (name, _) in enumerate(imps):
    print(f"const p{i}: never = null as unknown as "
          f"Exclude<(typeof {name})[number]['name'], RpcMethodName> // {name}")
print('export {}')
PY
find config -maxdepth 1 -name '*.tsbuildinfo' -delete
pnpm run typecheck:node 2>&1 | grep "__probe"
rm -f src/main/runtime/rpc/__probe.ts
```

Every line that prints a **union** of names is fine — those are the genuinely uncatalogued methods.
The one that prints `string` is the widened array.

**The right move.** Two edits, neither of which touches what the gate checks:

1. Drop the widening constraint from the wrapper's inference site —
   `<TMethods extends readonly unknown[]>(methods: TMethods): TMethods`, casting internally — and
   drop any `: readonly RpcAnyMethod[]` / `: RpcMethod[]` annotation from the fork's own method
   arrays, which upstream removed from its own in the same release.
2. Declare the fork's uncatalogued method names in a fork-owned module and union it into
   `UncataloguedMethod` as a two-line seam. Do not paste fifteen names into the upstream file.

Then regenerate the catalog (`node config/scripts/generate-rpc-params-catalog.mjs`) — it picks up
fork methods on its own, so this part self-heals every sync. Two upstream methods can land in the
fork's list too: `projectGroup.delete` and `repo.rm` both take a main-side schema once the
project-ledger feature extends them, which weakens wire parity for exactly those two until the
schema moves shared-side. Say so in the PR rather than leaving it implicit.

## Re-measuring residuals reads the worktree, not `HEAD`

**What happened.** After a fix that changed a seam, re-measuring every budget with
`git diff --numstat "$UPSTREAM_TARGET" HEAD -- <paths>` reported *zero* changes, and
`--verify-residuals` then failed on the one file that had actually moved. The uncommitted fix was
invisible to a `HEAD`-to-`HEAD` diff.

**The tell.** A re-measure that reports no changes immediately before `--verify-residuals` reports
drift. The two disagree because they are reading different trees.

**The right move.** Drop the second ref: `git diff --numstat "$UPSTREAM_TARGET" -- <path>` compares
the tag against the **working tree**, which is what `--verify-residuals` measures. Either re-measure
that way, or commit first and keep the explicit `HEAD`. Do not re-baseline from a `HEAD`-form
measurement taken over uncommitted work.

## Upstream can delete a stable tag the fork has already absorbed

**What happened.** The 2026-09-17 run merged `v1.4.206` (`c464b10149`, "release: v1.4.206",
2026-09-18) and the fork shipped `v1.4.207-rc.0.zy01` on it. By 2026-09-19 upstream had **deleted**
`refs/tags/v1.4.206` — no `v1.4.206`, no `v1.4.206-rc.*`, nothing — leaving `v1.4.205` (a day
*older* than what `main` carries) as the newest strict `vX.Y.Z` tag on the remote. Upstream had
re-cut `release/v1.4.206-adhoc` at `b10226a7ed`, a commit that does **not** descend from the
retracted release commit.

Every guard in Step 1 and Step 2 passes this through as an ordinary sync. `ls-remote` exits 0,
`$STABLE_TAG` matches `^v[0-9]+\.[0-9]+\.[0-9]+$`, the fetch-by-refspec succeeds, and
`merge-base --is-ancestor "$UPSTREAM_TARGET" origin/main` fails — which reads as "new release to
take", because stable tags never live on `main` and that check fails for an older tag exactly as it
does for a newer one. The run would then merge and, at Step 6, `git checkout v1.4.205 --` every
upstream-owned path: a whole-release rollback, silently breaking the fork commits written against
the newer release (here `58a42923cb`, "adapt three fork surfaces to v1.4.206 API shapes").

**The tell.** `$STABLE_TAG` is not strictly newer than `upstream_synced` in `CHANGELOG.md`'s
frontmatter. Step 2 now checks this first. Confirm the retraction rather than assuming a truncated
listing — an exact query is unambiguous where a glob plus `tail -1` is not:

```sh
git ls-remote upstream "refs/tags/${SYNCED}"     # prints nothing: the tag is gone
git tag -l "$SYNCED"                             # prints it: the fork still has it locally
```

A local tag with no remote counterpart is the signature. `ls-remote` printing nothing for an exact
ref is not the truncation failure Step 1 warns about; that one shows up as a non-zero exit or a
short ref count.

**The right move.** Change nothing. Record "no new stable release (main already carries
`$SYNCED`; latest remaining upstream stable tag `$STABLE_TAG` is older)", do Steps 12–14 as usual —
`main` was never touched, so the mirror branch, the backup prune, and the release check all still
apply — and raise the retraction as "needs attention". Do **not** merge the older tag, do not
substitute `upstream/main`, and do not delete the local tag to tidy up.

Two consequences a human needs to hear about, neither of which the run can settle:

- **The fork may be shipping a release upstream pulled.** `v1.4.207-rc.0.zy01` is built on a commit
  upstream has since untagged. Why it was retracted is upstream's information, not the run's.
- **The local tag is now load-bearing for the release skill.** `release` resolves its anchor with
  `git describe --tags ... HEAD`, which reads *local* tags. With `v1.4.206` present the anchor is
  correct; prune it (a fresh clone, or `git fetch --prune-tags`) and the anchor silently falls back
  to `v1.4.203`, which would compute `1.4.204-rc.0.zyNN` — **below** the already-published
  `1.4.207-rc.0.zy01`, regressing the series and breaking auto-update ordering. That is the
  `release` skill's to fix, so report it; do not edit that skill from a sync run.

**Do not mistake this for the Step 2 short-circuit's usual shape.** "Already at `$STABLE_TAG`" means
`main` contains the tag. Here `main` contains something upstream no longer publishes, and the two
want the same action for opposite reasons — so say which one happened in the report.

**Do not mistake a re-cut `release/*` branch for a resolution either.** If upstream re-tags
`v1.4.206` at `b10226a7ed`, the next run sees a tag `main` does not contain and merges it, leaving
`main` with two distinct "release: v1.4.206" commits. That merge is legitimate — the tag would be a
real new release — but the duplicate is worth expecting rather than diagnosing from scratch.
