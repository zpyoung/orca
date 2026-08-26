# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

## Electron UI Validation

Use the `$electron` skill and Playwright CDP for rendered Orca UI checks. Do not use computer-use for Orca UI validation.

# Style
## Concise/Brief Non-obviosu comments ONLY
  * DO NOT: be verbose, explain the obvious, walk through the code ("WHY not HOW")
  * BE CONCISE. 1 LINE if possible

## Lint Rules: Do Not Disable Max Lines

NEVER add a `max-lines` disable (`eslint-disable max-lines`, `oxlint-disable max-lines`, or line-specific variants), and never add a per-file `max-lines` bump in `mobile/.oxlintrc.json`.

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Type Declarations: Prefer `.ts` Over `.d.ts`

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

# Considerations
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

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.
- **Windows setup scripts**: the setup/issue-command runner is a `.cmd` batch file unless the script starts with a `#!` line — never derive that from the user's terminal-shell preference, and never launch a `.cmd` runner with a bare `cmd.exe /c` from a Git Bash pane (MSYS rewrites the `/c`). See [`docs/reference/windows-setup-shell.md`](./docs/reference/windows-setup-shell.md).
- **Windows child processes**: start them through `runProcess`/`spawnProcess` in `src/shared/child-process/` — never `child_process` directly. It pins `windowsHide`, refuses `shell: true`, and encodes `.cmd`/`.bat` arguments so neither `CommandLineToArgvW` nor `cmd.exe` mangles them. A ratchet test fails on any new direct import.
- **Windows process enumeration**: read the table through `src/main/windows/windows-process-table.ts`, never by forking `powershell.exe`. See [`docs/reference/windows-process-enumeration.md`](./docs/reference/windows-process-enumeration.md).
- **WSL commands**: build argv with `buildWslExecArgs` (always `--exec` — under `--`, `wsl.exe` expands `$name` in every argument and silently rewrites the script), and fence anything whose stdout you parse with `buildWslCapturedLoginShellCommand`, because the interactive login shell prints the distro banner to stdout. See [`docs/reference/wsl-command-execution.md`](./docs/reference/wsl-command-execution.md).
- **Linux native modules**: keep the glibc floor at Ubuntu 20.04 / glibc 2.31. A module compiled from source on a newer runner can reference symbol versions absent on the floor and crash the app on startup. See [`docs/reference/linux-glibc-compatibility.md`](./docs/reference/linux-glibc-compatibility.md); packaging fails if a bundled native binary needs newer glibc.

## SSH Use Case

All changes must consider the SSH use case. Don't assume local-only execution. Before changing anything that reports on, stops, or lists remote work, follow [`docs/reference/ssh-execution-boundary.md`](./docs/reference/ssh-execution-boundary.md): the execution host owns everything that touches execution, and loss of contact is never evidence of process death — the verdict vocabulary is `live` / `unverifiable` / `exited`, with no synonyms.

## Folder Workspace Use Case

All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree.

## Remote Wire Compatibility

Clients and remote Orca servers update independently, so mixed versions are the normal state. Before changing anything a paired client and host exchange — RPC params, stream frames, or the content either side publishes over them — follow [`docs/reference/remote-wire-compatibility.md`](./docs/reference/remote-wire-compatibility.md). A new optional field is safe; a new stream opcode must be capability-negotiated because decoders drop unknown opcodes silently; and changing what the host publishes reaches old clients even with no wire change.

## Git Binary Compatibility

Orca runs the user's Git binary on native, WSL, and SSH hosts, which may all have different versions. Treat Git 2.25 as the core-workflow baseline and follow [`docs/reference/git-compatibility.md`](./docs/reference/git-compatibility.md).

When adding or changing a Git command:

- Check when every subcommand and option was introduced. For newer behavior, keep a baseline-compatible fallback or degrade safely.
- Use `GitCapabilityCache` with a narrow unsupported-error predicate so recurring operations do not retry a known-invalid command. Do not rely only on `git --version`; wrappers such as `simple-git` do not remove host-version differences.
- Scope capability state to the host that executes Git: native, WSL distro, SSH provider, or relay connection. Cover the first fallback, later cached calls, concurrent probes, and relevant host isolation in tests.
- Keep the real-binary compatibility contract in PR CI current. When adopting a newer Git feature, add its version boundary so the preferred command and fallback both run against representative Git releases.
- Preserve commands that begin with global Git options such as `-c` before the subcommand, including auto-maintenance suppression used by worktree-create fetches.

## Git Provider Compatibility

Source-control and review changes must consider GitLab and other supported git providers, not only GitHub. Keep provider-specific behavior behind explicit checks, and avoid GitHub-only naming for generic review concepts.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.
