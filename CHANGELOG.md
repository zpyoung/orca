---
last_released_commit: 028efe682bb83e32a1ded4c8dce81572d7f4e083
upstream_synced: v1.4.195
---

# Changelog

Changes owned by the [`zpyoung/orca`](https://github.com/zpyoung/orca) fork. Upstream changes
inherited from [`stablyai/orca`](https://github.com/stablyai/orca) are recorded as a single sync
line per release, and detailed in each GitHub release's generated notes.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). It is maintained by the
`release` skill — see `.claude/skills/release/SKILL.md`.

## [1.4.196-rc.0.zy01] - 2026-09-02

Synced to upstream [v1.4.195](https://github.com/stablyai/orca/releases/tag/v1.4.195).

### Fixed
- The Session Info sidebar still reports Claude's hook status. Upstream removed the `agentHooks`
  IPC surface as dead code — it had no callers left there, but the fork's panel read
  `claudeStatus()` from it. The row now goes over the fork's own Session Info bridge, which reaches
  the same unchanged main-process service.
- The browser annotation tray no longer paints a frame still in edit mode for an annotation that
  has just been deleted or cleared. The edit state is reset while rendering instead of afterwards
  in an effect. Filed for upstream.

### Changed
- The fork's composer picks up upstream's app-menu Select All fix. Upstream landed it in the chat
  composer it replaced, so it is replayed into the shared composer core, where it reaches the
  docked terminal composer as well.
- Upstream's new attachment preview is deliberately not adopted: the fork already renders image
  thumbnails in its own composer chips, and swapping in upstream's component would reconcile that
  away. Only the per-attachment connection id it introduced was taken.
- The release pipeline gains upstream's `release-preflight` gate ahead of macOS signing, minus the
  two skill-sharing gates this fork's macOS-only pipeline does not define.
- Two cross-version and updater tests now exercise the fork's own release feed and tags instead of
  upstream's, which do not exist on this remote.

## [1.4.195-rc.0.zy01] - 2026-09-01

Synced to upstream [v1.4.194](https://github.com/stablyai/orca/releases/tag/v1.4.194).

### Added
- A Session Info sidebar for the focused agent terminal, showing live context, usage, identity,
  activity, files, hooks, and MCP servers for that exact session and pane. A custom Claude
  statusline survives, because the fork chains its own telemetry rather than replacing it, and MCP
  servers are deduplicated by name across config scopes.
- Shared artifacts can be passphrase-protected. Content is encrypted in the browser before upload,
  the passphrase is stored locally, and protecting, rotating, removing, and recovering protection
  all work from the CLI, the RPC layer, and the desktop UI.

### Fixed
- Passphrase protection is now reachable from the desktop app at all. Every protect, rotate,
  make-public and reveal action threw for the renderer, whose IPC bridge dispatches as a runtime
  client, so only the CLI could use the feature. The same pass fixed a replacement passphrase being
  minted under a key that was never persisted, a removal that could brick a source key for later
  shares, a stale removal intent that could republish a deleted artifact's plaintext, protection
  state leaking into results that paired clients are meant not to see, an unregistered locale
  bundle that left every non-English catalog empty, an "unknown on this version" message shown
  while the status lookup was still in flight, and a re-validation of the whole store once per
  record on every list refresh.
- The changed-lines type-aware code-quality scan no longer reaches into `mobile/`. It pinned the
  root oxlint config over a workspace that has its own config, lockfile, and uninstalled
  dependencies, so every React Native type resolved as an error type and the rule fired on the
  resolution failure rather than on the code. Filed for upstream.

### Changed
- The remote test sandbox follows upstream onto pnpm 12 and off the deleted `.npmrc`.
- Contributor docs now describe the forked Native Chat architecture and its runtime changes, and
  point local typechecking at the per-project commands so a full sweep cannot saturate the machine.

## [1.4.194-rc.0.zy01] - 2026-08-31

Synced to upstream [v1.4.193](https://github.com/stablyai/orca/releases/tag/v1.4.193).

### Added
- The docked terminal composer now renders Markdown as you type, over a draft that stays raw
  underneath, so styling never rewrites what will actually be sent.

### Changed
- Focus goes to an enabled dock composer before falling back to the terminal beneath it, so typing
  after a reveal or reattach lands where the composer is showing.
- Upstream's updated structured native-chat session (Codex, off by default behind
  **Use updated structured native chat**) now runs through this fork's shared agent composer rather
  than a second chat-only one, so the chat pane and the terminal dock keep one draft, history, and
  attachment path.

### Fixed
- Continue-in-new-session no longer hands over a stale transcript. A fork-owned probe authorizes
  against the Vault's agent-source roots and walks an ordered candidate chain — reported path,
  session id, pane history, then project scan — recording where each answer came from. Ambiguous
  project scans are refused rather than guessed, an unreachable host now reports `unverifiable`
  instead of `missing`, and the same chain runs against SSH targets.
- Claude's startup options repaint as PTY output settles, so the model and effort pills stop showing
  a stale selection from the previous session.
- Switching a pane's PTY resets the reported screen state, and composer scroll sync now initializes
  once the textarea ref attaches — fixing a desynced overlay on the first paint after a switch.
- Inline Markdown scanning is bounded per line, so a long draft no longer degrades typing latency.
- The packaged CLI can resolve `claude-accounts/keychain` again; it was missing from the fork's
  `asarUnpack` list, which a restored packaging check caught.
- `use-checks-list-state` no longer writes a ref inside a state updater. React may run an updater
  more than once, so the write moved into the effect that queues it.

## [1.4.191-rc.0.zy01] - 2026-08-26

Synced to upstream [v1.4.190](https://github.com/stablyai/orca/releases/tag/v1.4.190).

### Added
- Continue a coding-agent session in a new one. A continuation dialog composes a handoff brief from
  the source pane or an AI Vault session, previews and edits it, scans it for secrets, resolves the
  target environment, and launches the receiving agent. Parent and child sessions are linked, and
  the relationship shows as a badge on agent rows and in the vault. Briefs can be built from a
  user-editable template catalog, with its own Settings pane and per-template steering notes.
- The right sidebar's Source Control glyph now carries a dot whenever the active worktree has
  uncommitted changes, and the count rides in the button title so the tooltip and the accessible
  name both carry it — color is never the only signal. Rows inside an expanded submodule are left
  out of the count so expanding one cannot make the number jump, and a truncated `git status`
  reports "N+" rather than a total it cannot know.
- Composer attachment chips show the image itself instead of a generic icon, so a composer holding
  several images is readable at a glance. On an SSH worktree the chip reads the client-local file
  the upload came from, since the remote path it attaches is not readable on the client.
- A setting controls whether the terminal composer docks itself automatically. It defaults to on,
  and turning it off suppresses automatic docking without closing composers that are already
  mounted. An explicit decision to undock now persists across clients, while an agent exiting can
  still bring the composer back.

### Fixed
- The skill picker scanned the frozen cache copy of a `directory`-sourced Claude Code marketplace
  rather than the live directory the harness actually loads plugins from, so it offered whatever
  skill set existed at the last `claude plugin update`. Directory marketplaces now resolve to their
  live `skills` directory; `github` and `git` marketplaces are untouched, because their cache copy
  is what the harness loads. A malformed registry degrades to the cached roots rather than dropping
  a plugin.
- A native file drop was broadcast to every mounted composer, so one drop attached to all of them.
  A drop now carries the tab and pane it landed on, and a composer ignores one addressed elsewhere.
- Live plugin-marketplace discovery inside WSL kept working across upstream's move to a single
  `wsl.exe` runner. The read now goes through that runner instead of spawning `wsl.exe` itself.

### Changed
- The upstream sync no longer runs the test suite locally before opening its pull request. That run
  went to a single shared Docker host, where sharding it produced timeout, perf-budget, and
  temp-file failures on a different random subset each time — none of them caused by the code. The
  pull request's own CI, which runs the same suite on clean hosted runners, is now the only test
  gate.

## [1.4.189-rc.0.zy02] - 2026-08-26

Synced to upstream [v1.4.188](https://github.com/stablyai/orca/releases/tag/v1.4.188).

### Changed
- Upstream syncs now land through a pull request rather than pushing `main` directly, so the fork
  ownership guard and the rest of PR CI run on every resolution before `main` moves. The sync
  procedure also gained a fix policy that separates failures a run may resolve on its own from ones
  that have to stop and ask a person.
- `pnpm test` no longer starts Vitest on a developer machine. It refuses unless it is running in CI,
  in a container, or under an explicit opt-out, and points at the sandboxed shard runner instead;
  where it does run, the worker pool is capped at half the host's cores.

## [1.4.189-rc.0.zy01] - 2026-08-24

Synced to upstream [v1.4.188](https://github.com/stablyai/orca/releases/tag/v1.4.188).

### Fixed
- Closing the docked composer no longer leaves a dead strip below the terminal. The pane's geometry
  effect used to re-run after the composer's own cleanup had zeroed the slot and write the gutter
  height straight back, so the terminal never grew into the space it had just been given.
- The docked composer no longer shows "No terminal session" over a live pane. It reads the pane's
  PTY id during render, and a reattach that lands on the id the layout already holds — recovery
  remount, tab move, web-mirror remount — used to produce no re-render at all, stranding the
  composer on the value it read while the attach was still pending.
- The fork's skill release ledger is now declared fork-owned, so a sync can no longer replace it
  with upstream's rows. Those rows name tags that exist only on `stablyai/orca`, which killed the
  skill-update roundtrip check across every matrix job the last time a sync took them.

### Changed
- The agent composer's draft, history, and attachment caches are built from one shared scope cache
  instead of three copies, the terminal-dock gutter clamp lives in one module rather than six call
  sites, and the dock-state merge paths are collapsed onto a single routine. Net 195 lines removed,
  with no behaviour change.

## [1.4.188-rc.0.zy01] - 2026-08-22

Synced to upstream [v1.4.187](https://github.com/stablyai/orca/releases/tag/v1.4.187).

### Added
- A rich-input composer can now be docked beneath a terminal pane running a supported coding-agent
  CLI, so a prompt can be drafted, edited, and sent without typing into the TUI, with the terminal
  still visible underneath as a fallback. Send and Stop are separate controls rather than one button
  that flips, and the pane quarantines input after its PTY endpoint is replaced so a send cannot land
  in the wrong session. Behind an experimental flag.
- `pnpm test:sandbox` runs the test suite in throwaway Docker containers, sharded, either locally or
  on a remote host. Shards no longer see each other's temp files, git config, or build output.

### Changed
- File ownership across the fork is now declared in `config/fork-ownership.json` and enforced in CI,
  instead of being inferred from commit authorship. Each fork change belongs to one of four tiers,
  and a PR that adds a fork file matching no manifest entry fails the ownership guard. This is what
  keeps a fork change from being silently reset the next time upstream is merged.
- The upstream-sync procedure now lives in a git-tracked skill rather than an automation prompt, so
  there is a single copy under test.
- Release builds register the `orca://` URL scheme, matching upstream.
- The release pipeline now runs least-privileged: the workflow's default token grants read-only
  access to repository contents, with write scoped to the single job that needs it.

### Fixed
- The workspace sidebar's tighter row spacing is applied again. Upstream moved the module holding it
  during a refactor, and because the fork still claimed the old path, the build had been shipping
  upstream's roomier spacing while the fork's copy sat unused. Drop targets line up with the rows as
  drawn once more.
- Reconnecting an SSH terminal surfaces the underlying error again, and native-chat panes hosted on
  a remote machine keep reading transcripts over this fork's relay through upstream's module split.
- Cross-repo worktree groups, the docked composer, and per-pane chat width all survive upstream's
  restructuring of the sidebar into ~105 modules; their behavior is unchanged.

## [1.4.185-rc.0.zy01] - 2026-08-17

Synced to upstream [v1.4.184](https://github.com/stablyai/orca/releases/tag/v1.4.184).

### Changed
- Native Chat continues to read transcripts over this fork's SSH relay. Upstream replaced that path
  with a WSL filesystem admission gate, which this build does not adopt, so reading transcripts from
  a remote host behaves exactly as it did before the sync.
- The workspace sidebar keeps this fork's tighter row spacing rather than upstream's roomier
  virtual-row gap, so drag-and-drop drop targets stay aligned with the rows as drawn.
- Index checks in two fork-owned files were rewritten to satisfy lint rules upstream newly enabled.
  No behavior changes; it keeps future upstream syncs from stalling on a toolchain change alone.

## [1.4.183-rc.0.zy01] - 2026-08-14

Synced to upstream [v1.4.182](https://github.com/stablyai/orca/releases/tag/v1.4.182).

### Added
- The native chat transcript is colored. Each recognized agent tool takes its own glyph and hue on
  its line, and a collapsed run of tool calls shows one dot per distinct kind of work in the order
  it first appeared — so a folded run says what happened without being expanded. Code blocks and
  inline code in chat are syntax-highlighted, the user bubble and reasoning rule are tinted, and
  every new color is held to a contrast floor in both themes. Tool names are matched exactly, so an
  agent whose vocabulary Orca does not know renders exactly as before rather than being assigned a
  color that claims something untrue about the call. Glyphs carry the same distinction as the hues,
  so color is never the only signal.

### Fixed
- Electron downloads that fail with an HTTP status response are retried instead of failing the run.
  The transient-error check read only `statusCode`, but the error raised for a rejected fetch
  carries `status`, so release-CDN 503s aborted on the first attempt and took several test lanes
  down at once.

### Changed
- Upstream code the fork does not own now tracks v1.4.182 directly. Where this release extended the
  same code the fork's SSH-relay chat feature touches, both sides are kept: upstream's transcript
  read cancellation, subscription teardown, quick-command matching, and cross-device workspace
  filtering are back alongside the fork's relay work. Files the fork does own — the workspace card,
  the live chat session hook, and the macOS-only signed build configuration — stay on the fork's
  versions, and three upstream tests that assert behavior this fork deliberately does not carry
  were dropped.

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
