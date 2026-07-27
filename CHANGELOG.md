---
last_released_commit: 1f3303bd2a45c32a66a1238e6777d875ecfd35fa
upstream_synced: v1.4.160-rc.0
---

# Changelog

Changes owned by the [`zpyoung/orca`](https://github.com/zpyoung/orca) fork. Upstream changes
inherited from [`stablyai/orca`](https://github.com/stablyai/orca) are recorded as a single sync
line per release, and detailed in each GitHub release's generated notes.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). It is maintained by the
`release` skill — see `.claude/skills/release/SKILL.md`.

## [1.4.160-rc.0.zy01] - 2026-07-27

Synced to upstream [v1.4.160-rc.0](https://github.com/stablyai/orca/releases/tag/v1.4.160-rc.0).

### Added
- A `release` skill that records fork-owned changes in this file and cuts a versioned build from
  them, so a fork release stays distinguishable from the upstream RC it was built on.

### Changed
- Release builds are signed, notarized, macOS-only, and auto-update from this fork rather than
  upstream. The app installs under its own name and bundle identifier, so it runs alongside an
  official Orca install instead of replacing it.
- The sidebar workspace list is denser: less space between rows, shorter section headers, and
  tighter padding inside each workspace card.

### Fixed
- Sidebar host headers no longer overlap the row beneath them at the tighter row spacing.
- The keyboard focus ring on repository header buttons is no longer clipped by the shorter header.
- Settings search keywords inherited from upstream no longer fail the fork's localization coverage
  check.
