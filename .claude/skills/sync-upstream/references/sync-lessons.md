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

**The tell, for a seam.** `--verify-residuals` is the only check that sees it, and the drift is not
subtle:

```
src/main/ipc/pty.ts: recorded +96/-1, measured +8111/-38
```

A residual measured in thousands means the tag replaced the file with a barrel, not that the fork
grew. Confirm with a line count — `git show "${UPSTREAM_TARGET}:<path>" | wc -l` against the
worktree copy — and list what replaced it with
`git ls-tree -r --name-only "$UPSTREAM_TARGET" -- <path-without-.ts>/`.

Two adjacent tells worth knowing. A seam path that no longer exists in the tag at all is the same
situation one step further along; compare the manifest's seam paths against
`git ls-tree -r --name-only "$UPSTREAM_TARGET"` as sets — in Python, or with `LC_ALL=C` on both the
`sort`s *and* the `comm`. Under the default macOS locale `comm` reports paths as missing that the
tag plainly contains; v1.4.195 got 120 false positives that way, against a true answer of zero. And
a residual that drifts by exactly one or two lines is *not* this — that is ordinary `-X ours` hunk
damage, where upstream added a parameter or an import the fork's side discarded, and it is repaired
in place.

**The tell, for an exception.** There isn't one — not from the manifest. `--verify-residuals` reads
`seams` only, so a split that lands on an exception-owned path passes every check while the fork
keeps the whole monolith and the merge adds the new modules beside it. The `ours.txt` audit in
Step 6 is what catches it, and the signature is a four-digit removal against a file the fork
supposedly owns:

```
29    2288  src/main/updater.ts
8     2180  src/main/rate-limits/service.ts
7     3497  src/renderer/src/components/terminal-pane/TerminalPane.tsx
```

v1.4.197 did all three at once, so a release splitting several exception files in one go is normal
rather than exceptional. Confirm the same way as for a seam — `git show "${UPSTREAM_TARGET}:<path>"
| wc -l` against the worktree copy — and note that the fork's *own* delta stays small: those three
were 2/2, 7/6 and 134/14 lines. A small fork delta against a huge upstream removal is the whole
shape.

**The right move.** Re-home the seam or the exception, do not defend the monolith:

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


## A split that arrives with its own parity ratchets

**What happened.** v1.4.197's `TerminalPane.tsx` split shipped three new test files beside the 74 it
created — `terminal-pane-hook-order-parity.test.ts`, `terminal-pane-listener-order-parity.test.ts`
and `terminal-pane-store-subscription-budget.test.tsx`. Each pins the refactor with an exact
equality: 204 flattened render hooks and a SHA-256 of their order, 24 DOM listeners and a SHA-256 of
theirs, and `expect(perPane).toBe(17)` for store subscriptions. The fork's `terminal-dock` feature
had lived inside that monolith as 134 added lines, and its integration adds four `useAppStore`
subscriptions and roughly thirty hooks *inside the pinned file set*. No re-home satisfies the pins.

**The tell.** The split's new files include tests whose constants are exact rather than upper
bounds. Grep the new siblings before planning any of the work:

```sh
comm -13 <(git ls-tree -r --name-only "$PREV_TAG" -- <dir>/ | LC_ALL=C sort) \
         <(git ls-tree -r --name-only "$UPSTREAM_TARGET" -- <dir>/ | LC_ALL=C sort) \
  | xargs git grep -lE '_SHA256|_BUDGET|toHaveLength\([0-9]' --
```

The escape hatch worth checking, because it sometimes works: read each pin's *file pattern*. The
hook-order pattern here covers `TerminalPane.tsx` and `use-terminal-pane-*.ts` only, so
`TerminalPaneSurface.tsx` and the runtime portals are outside it, and a fork mount rendered from the
surface costs nothing. It did not rescue this one, because the budget test mounts
`useTerminalPaneController` directly and the dock's cross-cutting calls — the
`notePanePtyBindingChanged()` in the layout-binding callbacks, the `paneDockOwnsFocus()` focus
guards, the retired-pane ref — have to sit in the controller chain.

**The right move.** Stop and raise it as a confirmed feature collision. Re-baselining a pinned SHA
or budget so a fork feature fits is the baseline bump the fix policy forbids, and it also hands the
fork permanent ownership of an upstream performance ratchet — every later upstream refactor of that
subsystem then re-conflicts, and the fork stops getting the regression protection the ratchet
exists for. **Do not mistake this for the ordinary re-home above**: the difference is not size, it
is whether the pins can be satisfied at all. Establish that first, from the test files, before
touching a line.
