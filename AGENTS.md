# Useful Commands

- **Typecheck**: `pnpm tc` (or `tc:node` / `tc:cli` / `tc:web`)
- **Test**: see [Running Tests: Remote Sandbox Only](#running-tests-remote-sandbox-only) — `pnpm test` is blocked on this machine
- **Lint**: `oxlint`, or `pnpm run check:code-quality:changed` for changed files (full `pnpm lint` is slow); format with `pnpm format`
- **Design system**: `pnpm run lint:design-system` for the full renderer report (not a gate); the changed-lines gate above is what CI enforces

# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

# Electron UI Validation

Always run tests and agent-launched apps in the background with `ORCA_BACKGROUND_LAUNCH=1`.
Never steal monitor focus or reveal test windows: no `show()`, `showInactive()`, `bringToFront()`,
`app.focus()`, or OS activation. Use CDP screenshots of hidden renderers. Keep native-focus and visible-window tests paused on the user's desktop; run them on an isolated display or CI.
Rebuild modified launch-policy code before running an app; stale build wrappers are not safe.

Use the `$electron` skill and Playwright CDP for rendered Orca UI checks. Do not use computer-use for Orca UI validation.

# Code Style

## Reuse Before Reimplementing

Before writing new logic at any scale — a function, component, IPC channel, state store, or whole subsystem/flow — check whether an existing implementation already does the job. Extend or generalize it instead of building a parallel version.

## Avoid Comments

- Only use when code does not describe
- BE CONCISE. 1 LINE if possible (why not how)

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Type Assertions: Prefer Checked Types

Avoid type assertions except `as const`. Unavoidable casts need a line-specific `SAFETY:` explanation:

# First Class Citizens

Every change must consider these areas:

## Cross-Platform Support

Support macOS, Linux, and Windows. Guard platform-specific behavior at runtime; use platform-aware shortcuts, paths, and existing process wrappers. Before changing platform-specific code, processes, shells, shortcuts, paths, or native modules, read [`docs/reference/cross-platform-support.md`](./docs/reference/cross-platform-support.md).

## Remote Use Case

Support remote execution as well as local. Clients and servers update independently; preserve compatibility across mixed versions.

## Mobile

Any feature should be considered for parity on mobile

## Folder Workspaces

All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree.

# Git / GitHub

If changing code around `git`, `gh`, source-control, or review behavior read [`docs/reference/git-workflow.md`](./docs/reference/git-workflow.md).

# Tests

Avoid adding low-value tests. These might be fine for development but offer low value when checked in. [Anti-patterns](./docs/reference/test-antipatterns.md)

## Running Tests: Remote Sandbox Only

Vitest never runs on this machine. Every test run goes to the remote Docker host through
[`config/docker/test-sandbox`](./config/docker/test-sandbox/README.md), which feeds each shard a
throwaway container over stdin — shards cannot see each other's temp files, git config, or build
output, and the laptop stays free.

```sh
pnpm test:sandbox --shards=16 --jobs=8            # full unit suite
pnpm test:sandbox --shards=16 --only=3            # one shard
pnpm test:sandbox --shards=16 --only=3 -- <args>  # extra vitest args
```

The host comes from `ORCA_SANDBOX_DOCKER_HOST` in `.claude/settings.local.json`, so no
`--docker-host` flag is needed. That file is machine-local and untracked — a fresh checkout has to
set it before the runner works.

A `PreToolUse` hook (`.claude/hooks/require-sandboxed-tests.mjs`, wired in `.claude/settings.json`)
rejects `pnpm test`, bare `vitest`, and their wrapped forms so the rule holds without relying on
anyone remembering it. The blocked script names are read from `package.json`, so a renamed vitest
script stays covered. Setting `ORCA_ALLOW_LOCAL_TESTS=1` in the environment disables the guard; an
inline `VAR=1 pnpm test` prefix does not, because it never reaches the hook process.

The `shell` and `e2e` lanes have not been run anywhere yet — treat a green run there as unproven.

## Typechecking: Scope It to What You Changed

Never run `pnpm typecheck` on this machine. It spawns three concurrent `tsc --noEmit` runs over the
whole repo, and with several worktrees open at once that is enough to saturate every core. The full
sweep belongs to the `typecheck` job in [`.github/workflows/pr.yml`](./.github/workflows/pr.yml),
which runs it against a cached `.tsbuildinfo` graph.

Locally, run only the project that owns the files you touched:

| Changed path                                                    | Command               |
| --------------------------------------------------------------- | --------------------- |
| `src/main/**`, `src/preload/**`, `src/relay/**`, `src/types/**` | `pnpm typecheck:node` |
| `src/renderer/**`                                               | `pnpm typecheck:web`  |
| `src/cli/**`                                                    | `pnpm typecheck:cli`  |
| `tests/**`                                                      | `pnpm typecheck:e2e`  |

`src/shared/**` is included by the node, web, and cli projects alike, and the cli project also pulls
in a fixed list of `src/main` modules named in `config/tsconfig.cli.json`. When a change spans more
than one project, run them one after another — never concurrently.

For a single file, prefer the editor's TypeScript language server over spawning `tsc` at all; it
answers from a graph that is already resident. `tsc --noEmit <file>` is not a substitute, because it
drops the project's `paths` aliases and JSX settings and reports errors that do not exist.

# Typed Observations: the Orca Ledger

When you notice something you cannot act on in this session, do NOT bury it in prose with phrases
like "pre-existing", "out of scope", "future work", or "skipped for brevity". File it in the Orca
ledger, which is keyed to the project, so entries survive worktree deletion and stay visible from
sibling worktrees of this repo.

```sh
orca ledger file --type bug      --title <t> --file <path:line> \
                                 --description <d> --severity critical|high|medium|low
orca ledger file --type deferred --title <t> --why-deferred <w> \
                                 --priority high|medium|low
orca ledger file --type test-gap --title <t> --file-under-test <path:line> \
                                 --reason-skipped <r>
orca ledger file --type proposal --title <t> --context <c> --recommendation <r>
orca ledger file --type decision --title <t> --context <c> --decision <d> \
                                 --consequences <q> --status proposed|accepted|superseded
orca ledger list   --type bug --state open --json
orca ledger show   --id bug-12 --json
orca ledger state  --id bug-12 --state resolved --if-revision <n> --json
orca ledger review --json
```

`--if-revision` takes the revision from `show`; a stale value returns `conflict` with the current
revision in `error.data.currentRevision`.

The ledger is the only surface, and it wins on any disagreement. BUGS.md, DEFERRED.md,
TEST_BACKLOG.md, proposals.md and docs/adr/ are legacy — read them for history, never append to
them. BUGS.md and DEFERRED.md were migrated; TEST_BACKLOG.md was not, so its entries live only in
markdown until someone files them. The `quirk:typed-artifacts` skill and the `/quirk:artifacts:*`
commands still write markdown; do not use them.

# Fork Feature Structure

This fork tracks upstream stable tags, and every sync resolves file ownership from
[`config/fork-ownership.json`](./config/fork-ownership.json) rather than from commit authorship. Work
that is not declared there is reset to the upstream tag at the next sync and silently reverted, so
declaring a change is part of writing it.

Every fork-authored change lands in exactly one of four tiers.

**Tier 1 — Isolated.** The default. Fork logic goes in a `fork-<feature>/` directory beside the
upstream code it extends, in every layer it touches (`src/shared/`, `src/main/`, `src/relay/`,
`src/renderer/`). The directory name is unique to the feature, so a single `**/fork-<feature>/**`
glob owns the whole vertical. Fork tests live in the fork directory beside the code they exercise,
and fork-only shared types are declared there too — never added to an upstream shared module.

**Tier 2 — Forked copy.** Only where the change is structurally interleaved and no seam is reachable.
Copy the upstream module into the fork directory, record the upstream path and source commit SHA in
a header line, and point consumers at it with an `import-swap` seam. Upstream's later changes must be
replayed by hand every sync, so choose this only when the alternative is a permanently fork-owned
upstream file.

**Tier 3 — Declared exception.** Files that _are_ the fork: release workflows, packaging config,
telemetry disablement, fork identity. Declare in `exceptions` with `status: "permanent"` and a reason
stating why upstream's version must not win.

**Tier 4 — Upstreaming.** Fixes to upstream behavior and cosmetic tweaks, where isolating is the
wrong shape. These stay in-place, declared in `exceptions` with `status: "pending-upstream"` and a
`ledger` pointer, and written up in [`docs/fork-upstreaming.md`](./docs/fork-upstreaming.md). The
manifest entry and the ledger entry are created and removed together.

## Seams

An upstream file may carry fork lines only as a seam — a line or two, never a block. Three kinds are
permitted: `registration` (one line wiring fork code into an upstream entry point), `import-swap` (a
consumer's import repointed at a forked copy), and `passthrough` (an upstream component forwarding a
value it does not interpret). Anything larger means forking and owning the module instead.

Declare the seam in `seams` with its lines verbatim, and record the file's total fork divergence in
`residuals` as `{added, removed}`. Whole-line presence checks cannot see a deletion or an undeclared
edit; the residual budget is what keeps a seam file's full footprint reviewable. Re-baseline a
residual only after re-reading the seam.

## Precedence

A per-file declaration always beats a glob:

1. `exceptions` — fork wins outright
2. `seams` — real three-way merge, never reset to the tag
3. `features` glob — real three-way merge, fork wins conflicts
4. otherwise — reset to the upstream tag

A path in both `seams` and `exceptions` is a manifest error, not a precedence question.

## CI enforcement

The `fork ownership guard` job in [`.github/workflows/pr.yml`](./.github/workflows/pr.yml) runs on
every PR and fails on a fork-added file matching no manifest entry (coverage), a glob matching zero
files or a declared path that no longer exists (stale entry), a feature glob capturing a file that
also exists upstream (silent capture), a declared seam line missing verbatim (seam integrity), and a
seam file whose measured diff no longer matches its recorded budget (residual budget).

Fork edits to an upstream-owned file are not blocked by the guard — but an undeclared edit is
reverted at the next sync, so declare it.
