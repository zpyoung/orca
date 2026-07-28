---
last_released_commit: e74897f170cb6743c11ac3c66dd471841fb3769d
upstream_synced: v1.4.160-rc.0
---

# Changelog

Changes owned by the [`zpyoung/orca`](https://github.com/zpyoung/orca) fork. Upstream changes
inherited from [`stablyai/orca`](https://github.com/stablyai/orca) are recorded as a single sync
line per release, and detailed in each GitHub release's generated notes.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). It is maintained by the
`release` skill — see `.claude/skills/release/SKILL.md`.

## [1.4.160-rc.0.zy04] - 2026-07-28

Synced to upstream [v1.4.160-rc.0](https://github.com/stablyai/orca/releases/tag/v1.4.160-rc.0).

The first release of this fork to publish artifacts. `1.4.160-rc.0.zy01` through
`1.4.160-rc.0.zy03` were tagged but never shipped — zy01 had no macOS signing credentials, and
zy02 and zy03 ran out of build time while Apple notarized. Everything below reaches users here.

### Added
- A `release` skill that records fork-owned changes in this file and cuts a versioned build from
  them, so a fork release stays distinguishable from the upstream RC it was built on.

### Changed
- Release builds are signed, notarized, macOS-only, and auto-update from this fork rather than
  upstream. The app installs under its own name and bundle identifier, so it runs alongside an
  official Orca install instead of replacing it.
- Builds are Apple Silicon only. Intel Macs are no longer supported: every architecture needs its
  own notarization pass from Apple, and no machine running this fork is Intel.
- The sidebar workspace list is denser: less space between rows, shorter section headers, and
  tighter padding inside each workspace card.
- Builds no longer collect or transmit telemetry. This fork runs no analytics project, so the
  transport is compiled out of the binary rather than left dormant behind a consent check.

### Fixed
- Sidebar host headers no longer overlap the row beneath them at the tighter row spacing.
- The keyboard focus ring on repository header buttons is no longer clipped by the shorter header.
- Settings search keywords inherited from upstream no longer fail the fork's localization coverage
  check.
