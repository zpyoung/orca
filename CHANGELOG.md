---
last_released_commit: df807fdd3d98fe6bcf31cfa9583f4a7fb252d9bc
upstream_synced: v1.4.180
---

# Changelog

Changes owned by the [`zpyoung/orca`](https://github.com/zpyoung/orca) fork. Upstream changes
inherited from [`stablyai/orca`](https://github.com/stablyai/orca) are recorded as a single sync
line per release, and detailed in each GitHub release's generated notes.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). It is maintained by the
`release` skill — see `.claude/skills/release/SKILL.md`.

## [1.4.181-rc.0.zy03] - 2026-08-13

Synced to upstream [v1.4.180](https://github.com/stablyai/orca/releases/tag/v1.4.180).

### Fixed
- Chat view now reads transcripts over the SSH relay when a pane is hosted on a remote machine.
  Previously it always read from local disk, so an SSH-hosted conversation showed a read error and
  the first message only appeared after toggling to the terminal and back. A transcript that does
  not exist yet is treated as an empty conversation rather than a failure, oversized snapshots are
  clipped to a wire byte budget instead of being lost, byte-bounded pagination can reach older
  history, subscriptions re-arm when the relay reconnects so an idle pane recovers on its own,
  retained sessions are keyed by SSH connection so rebinding a pane between hosts cannot show the
  previous host's messages, and read failures surface inline with a retry option.
- CI retries the Electron download failures it actually hits — refused HTTP/2 streams and 5xx
  responses are now classified as transient, with a retry budget long enough to outlast observed
  CDN degradations.

## [1.4.181-rc.0.zy02] - 2026-08-12

Synced to upstream [v1.4.180](https://github.com/stablyai/orca/releases/tag/v1.4.180).

### Added
- An architecture reference for the plugin subsystem, covering the trust tiers, the contribution
  types a manifest can declare, the host API available to each runtime, and the limits that apply
  to plugin workers and panels.

### Fixed
- Skill updates verify again. The v1.4.180 sync adopted upstream's skill ledger, whose release rows
  name upstream tags that do not exist on this fork, so the roundtrip check failed outright. The
  ledger is now rebuilt from the fork's own release tags, and the check stands down for a skill that
  has only one recorded revision to move between — it reactivates on its own as fork releases
  accumulate.
- The upstream-sync skill is tracked in git again. It lived under a gitignored path, so the sync
  automation would have called a skill its checkout could not see.

### Changed
- Local memsearch index data is ignored instead of surfacing as untracked files.

## [1.4.181-rc.0.zy01] - 2026-08-11

Synced to upstream [v1.4.180](https://github.com/stablyai/orca/releases/tag/v1.4.180).

### Added
- Worktrees can be placed in a project group independently of the group their repo belongs to, so
  the sidebar can group related work across repositories. Grouping is presentational — running
  commands stays scoped to each worktree's own repo.

### Fixed
- The native chat view no longer blanks to a loading pane when an agent finishes its turn. Session
  retention could discard messages the live view had already committed to showing; it now only ever
  adds to that list.
- Deleting a provider session from the AI Vault is available again, together with upstream's fixes
  that block deletion of a live session and contain deletion on WSL. The fork had been carrying an
  upstream revert of this feature that upstream itself had already superseded.
- The Cmd+J palette picks up upstream's current open-tab search, recent chats and terminals, and
  digit shortcuts. The fork had been holding an earlier draft of the same work.

### Changed
- Upstream code the fork does not modify now tracks each upstream stable release directly, instead
  of preserving whatever variant an earlier sync happened to inherit. Several subsystems had drifted
  onto stale copies that upstream had since reworked.

## [1.4.178-rc.0.zy01] - 2026-08-09

Synced to upstream [v1.4.177](https://github.com/stablyai/orca/releases/tag/v1.4.177).

## [1.4.177-rc.0.zy01] - 2026-08-07

Synced to upstream [v1.4.176](https://github.com/stablyai/orca/releases/tag/v1.4.176).

### Added
- Native chat panes have a configurable reading column. Pick a width from the new menu in the pane
  header, or set the default for every pane from the experimental chat settings. The tier names and
  descriptions are translated into Spanish, Japanese, Korean, and Chinese.
- A checked-in `.nvmrc` pinning Node 24, so `nvm use` matches the version the project already
  requires. Upstream removed the file; the fork keeps it.

### Fixed
- The chat width menu no longer appears in the pane header when the experimental native chat
  surface is switched off. It read the tab's raw view mode rather than the mode actually in effect,
  so a chat-only control could surface on a plain terminal pane.

### Changed
- The fork no longer carries its own copy of the orchestration subsystem. It was restored here
  after upstream pulled it from the v1.4.161 release branch, but upstream has since shipped a newer
  version of the same code, so the fork now tracks upstream's directly. This brings creator-dispatch
  task attribution and the newer worker-release handling that the fork's copy never had.
- Two upstream fixes the fork had picked up early — the relay's refusal to fall back silently when
  a pairing invite fails, and the new-workspace flicker when typing ahead of search — are dropped in
  favour of upstream v1.4.176's versions of those files. They return when upstream ships them.

## [1.4.163-rc.0.zy01] - 2026-07-30

Synced to upstream [v1.4.162](https://github.com/stablyai/orca/releases/tag/v1.4.162).

### Added
- Orchestration is back. Upstream pulled its orchestration primitives and connected-server workers
  out of the v1.4.161 release branch, and the fork inherited that removal when it synced. Upstream
  shipped the subsystem again in v1.4.162, so the orchestration CLI, runtime, and federation
  workers return with it.

### Fixed
- The macOS permission-prompt watcher new in v1.4.162 now recognises this fork. It counts the
  consent dialogs macOS raises in Orca's name, but matched only upstream's bundle identifiers, so on
  a fork build it silently counted nothing.
- Mobile pairing screens no longer break the Spanish, Japanese, Korean, and Chinese catalogs.
  Upstream shipped these strings in English only; the fork carries English placeholders for them,
  matching the fallback already shown at runtime, until upstream ships translations.

## [1.4.162-rc.0.zy01] - 2026-07-29

Synced to upstream [v1.4.161](https://github.com/stablyai/orca/releases/tag/v1.4.161).

### Fixed
- The `orca` command-line tool works again on this fork. Its launcher looked for a binary named
  `Orca` inside the app bundle, but fork builds ship it as `Orca Dev` so the app can install beside
  official Orca — so every invocation failed with "No such file or directory". The launcher now
  reads the bundle's own executable name instead of assuming upstream's.

### Changed
- Upstream's new local-build compatibility contract is pinned to this fork's application identity
  (`com.zpyoung.orca`). Locally-built artifacts are validated against the fork rather than upstream,
  so a local build installs over a fork build instead of being rejected as foreign.

## [1.4.160-rc.0.zy06] - 2026-07-28

Synced to upstream [v1.4.159](https://github.com/stablyai/orca/releases/tag/v1.4.159).

This build re-bases the fork on upstream's stable v1.4.159. Earlier `zy` builds were cut from
upstream trunk, which had already moved past 1.4.159 and carried an unreleased regression that left
a stale terminal pane painted over file tabs. The fork now follows upstream stable tags only, so
this release intentionally carries *older* upstream code than 1.4.160-rc.0.zy05 despite the higher
version number.

### Added
- A `release` skill that records fork-owned changes in this changelog and dispatches the release
  pipeline, so fork cuts no longer collide with upstream's inherited rc numbering.

### Changed
- Releases are signed, notarized, macOS-only, and published to this fork, so a second Mac
  auto-updates from `zpyoung/orca` instead of upstream. The build installs under its own identity
  ("Orca Dev", `com.zpyoung.orca`) and runs alongside official Orca.
- Mac artifacts are arm64-only. Each architecture is a separate ~40-minute notarization submission
  under this fork's new Developer ID team, and no fork machine runs Intel.
- The left-sidebar workspace list is denser — tighter row gaps, shorter card padding, and a shorter
  section header — without changing worktree-to-worktree spacing.
- Telemetry transport is compiled out. The fork ships no PostHog project, and leaving it enabled
  failed the mac release build only after signing and notarization had already run.
- Release versions anchor on the newest upstream stable tag reachable from `main` rather than the
  trunk merge base, which would otherwise freeze once the sync tracks stable releases.

### Fixed
- Release builds no longer die mid-notarization. Apple takes ~43 minutes for this fork where
  upstream clears in ~9, so job and attempt timeouts are sized for the slower queue.
- The homebrew tap bump no longer runs on the fork, which has neither the upstream tap nor the app
  credentials it authenticates with.
- Settings-search keywords carrying the Ghostty brand name are allowlisted, so the localization
  coverage check passes.
- Sidebar host headers no longer overlap the row beneath them at the tighter row gap, and the focus
  ring on repo-header action buttons is no longer clipped.
