---
last_released_commit: ff1e6830afbc5db91e95d5505168fb0774ee5aec
upstream_synced: v1.4.159
---

# Changelog

Changes owned by the [`zpyoung/orca`](https://github.com/zpyoung/orca) fork. Upstream changes
inherited from [`stablyai/orca`](https://github.com/stablyai/orca) are recorded as a single sync
line per release, and detailed in each GitHub release's generated notes.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). It is maintained by the
`release` skill — see `.claude/skills/release/SKILL.md`.

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
