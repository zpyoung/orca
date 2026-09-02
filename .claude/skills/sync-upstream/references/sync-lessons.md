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

