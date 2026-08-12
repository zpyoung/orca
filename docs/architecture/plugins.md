# Plugins (the experimental `pluginSystemEnabled` extension system)

> Engineer onboarding reference for Orca's plugin system — what third-party code
> can contribute, what the host guarantees, and where the walls are.

## 1. What it is (the one-paragraph version)

**A plugin is a directory containing `orca-plugin.json` that contributes UI
panels, commands, keybindings, language packs, and VM recipes to Orca, and may
optionally ship a Node worker entry that runs out-of-process.** Everything a
plugin can reach through the host is declared as a capability in its manifest,
consented to by the user against a fingerprint, and re-enforced in main at every
callable boundary. Installs are immutable hash-addressed trees behind an atomic
pointer swap, sourced from a local path, a git URL, or a marketplace index.

The single most important mental model:

> **Capabilities gate the host API, not the machine.** A panel is genuinely
> sandboxed (opaque origin, `connect-src 'none'`, three callable methods). A
> worker is a plain Node process with full filesystem, network, and subprocess
> access. Installing a worker plugin is a trust decision about the publisher;
> the capability list is disclosure, not containment.

Everything here is **EXPERIMENTAL** — no compatibility promises until `pluginApi`
v1 freezes (`src/shared/plugins/plugin-manifest.ts:30`).

## 2. Feature gating

| Setting | Type | Default | Where |
|---|---|---|---|
| `pluginSystemEnabled` | `boolean` | `false` | `src/shared/types.ts:2972`, default `src/shared/constants.ts:316` |
| `devPluginPaths` | `string[]` | `[]` | dev-mode plugin roots loaded from arbitrary local dirs |
| `pluginConsents` | `Record<string, string>` | `{}` | pluginKey → reviewed consent fingerprint |
| `disabledPlugins` | `string[]` | `[]` | explicit user disables |

Surfaced in **Settings → Plugins**
(`src/renderer/src/components/settings/PluginsSettingsSection.tsx`).

With the flag off, **no plugin code path runs at all** — discovery returns
nothing, the marketplace is not seeded, bundled plugins are not published, and
the right sidebar filters plugin panels out entirely
(`src/main/index.ts:2555`, `src/renderer/src/components/right-sidebar/index.tsx:93`).

## 3. Trust tiers

The consent dialog classifies every plugin into exactly one tier
(`PluginConsentDialog.tsx:29`). This classification *is* the security model, and
it is what the consent fingerprint covers.

| Tier | Contributions | Executes |
|---|---|---|
| **Declarative** | commands aliasing built-in actions, language packs | nothing |
| **Panel** | `contributes.panels` | JS inside an opaque-origin sandboxed iframe |
| **Instructional** | keybindings, VM recipes, agent profiles | later, under **user or agent** authority |
| **Worker** | `main` | a full Node process |

"Instructional" is the subtle one: a VM recipe is a shell command Orca will run
on your behalf, and a keybinding rebinds a chord you press. Those bytes execute
later under your authority, so consent is bound to their **immutable tree hash**,
not just the manifest (`plugin-consent-fingerprint.ts:24`).

## 4. The manifest

`orca-plugin.json` at the plugin root, validated identically by desktop main,
headless `orca serve`, the relay, and the CLI — the schema lives in `shared` for
exactly that reason (`src/shared/plugins/plugin-manifest.ts`).

```json
{
  "manifestVersion": 1,
  "id": "hello-orca",
  "publisher": "orca-samples",
  "name": "Hello Orca",
  "version": "1.0.0",
  "engines": { "orca": ">=1.4.0" },
  "pluginApi": 1,
  "main": "main.mjs",
  "contributes": {
    "panels": [{ "id": "hello", "title": "Hello Orca", "icon": "plug", "entry": "panel.html" }],
    "commands": [{ "id": "hello-ping", "title": "Hello: Ping" }],
    "events": [{ "on": "worktree.created" }]
  },
  "capabilities": [{ "kind": "storage" }, { "kind": "events:subscribe" }]
}
```

Canonical identity is `<publisher>.<id>` — bare-id global uniqueness is
unverifiable without a registry. That qualified key is also the install
directory name and the uninstall target.

### 4.1 Contribution points

`contributes` is `.strict()`. Seven keys, all with hard caps:

| Key | Limit | What it does |
|---|---|---|
| `panels` | 64 | HTML entry rendered in the **right sidebar**, Lucide icon in the activity bar |
| `commands` | 256 | alias to a built-in action, **or** a handler registered in the worker |
| `events` | 3 | subscriptions; server-side filtered so you only receive what you asked for |
| `keybindings` | 256 | bound to your own commands; normalized cross-platform |
| `languagePacks` | 16 | i18next bundles per locale — these really do retranslate Orca's chrome |
| `vmRecipes` | 64 | `create`/`suspend`/`resume`/`destroy` shell lifecycle for disposable VM workspaces |
| `agents` | 64 | **declared, validated, consent-covered — and unconsumed** (see §9) |

### 4.2 Cross-field validation

`validatePluginManifestContributions` (`plugin-manifest-contribution-validation.ts`)
rejects at parse time:

- duplicate panel/command ids, language-pack locales, recipe/agent paths
- duplicate keybindings, checked against **all three** platform conflict
  identities so a Mac-only collision still fails on Linux
- `action` values outside the closed built-in alias set
- keybindings referencing an unknown command, or whose `when` disagrees with the
  command's `context`
- `contributes.events` non-empty without the `events:subscribe` capability
- a worker command or any event subscription without `main`

### 4.3 Engine gate

`engines.orca` accepts **only** the `">=x.y.z"` grammar
(`plugin-manifest.ts:41`). No ranges, no upper bounds, no caret. Prerelease and
build suffixes on the host version are ignored for ordering. A closed grammar
keeps the gate predictable; richer ranges can be added later without breaking
old manifests.

## 5. Capabilities and the host API

### 5.1 The capability set

Seven closed, unscoped kinds (`plugin-capabilities.ts:15`). Closed on purpose: a
typo — or a capability from a newer Orca — fails manifest validation instead of
silently granting nothing. Scoped kinds (`net:fetch` hosts, `process:exec` globs)
are deferred.

Each has consent copy shown verbatim in the install dialog:

| Kind | Shown to the user |
|---|---|
| `workspace:read` | Read the name, branch, and terminal list of your focused worktree |
| `terminal:send` | Type text into a terminal you can see (always a specific terminal) |
| `notifications:show` | Show desktop notifications labeled with the plugin name |
| `storage` | Store data in the plugin's own storage folder |
| `secrets` | Store and read secrets in the plugin's own encrypted vault |
| `events:subscribe` | Get notified when worktrees are created or removed and when agent status changes |
| `settings:own` | Read and change the plugin's own settings |

### 5.2 The method table

`PLUGIN_HOST_API_V0` (`plugin-host-api.ts:122`) is the **single source of truth**
for the capability gate, the panel bridge action set, and the worker SDK — so
those three surfaces cannot drift. The raw runtime-RPC registry is never
exposed: its methods have no result schemas and evolve at internal velocity.

| Method | Capability | Scope | Mutates | Panel-callable |
|---|---|---|---|---|
| `workspace.readContext` | `workspace:read` | active-worktree | — | ✅ |
| `terminal.sendText` | `terminal:send` | explicit-terminal | ✅ | ✅ |
| `notifications.show` | `notifications:show` | desktop | ✅ | ✅ |
| `storage.get` / `.set` / `.delete` / `.keys` | `storage` | plugin-private | set/delete | ❌ |
| `secrets.get` / `.set` / `.delete` | `secrets` | plugin-private | set/delete | ❌ |
| `settings.get` / `.set` | `settings:own` | plugin-private | set | ❌ |
| `events.subscribe` | `events:subscribe` | host-events | — | ❌ |

Mutations are audit-logged with actor `plugin:<id>` (`plugin-audit-log.ts`).

Payload caps: `terminal.sendText` text ≤4096 chars; notification title ≤120,
body ≤1000; storage 256KB per value, 5MB total, 1024 keys; secrets 64KB per
value.

### 5.3 `terminal.sendText` is never "the active terminal"

The API has no active-terminal write target, by design. Callers must pass an
explicit `terminalId`, and the host re-lists the resolved worktree's terminals
immediately before routing input (`plugin-host-method-bindings.ts:102`):

```ts
const context = await services.resolveActiveWorktreeContext()
const terminals = await services.listWorktreeTerminals(context.worktreeId)
if (!terminals.some((terminal) => terminal.id === terminalId)) {
  throw new Error('terminal is outside the active worktree')
}
```

A focus change must not redirect a delayed plugin write into another pane.

## 6. Runtimes

### 6.1 Worker

Forked lazily on the first trigger — never at startup
(`plugin-host-process.ts:88`):

```ts
fork(entryPath, [], {
  env: buildPluginWorkerEnv(),   // allowlist, never ...process.env
  execArgv: [],                   // Orca's inspector/loader flags must not leak in
  serialization: 'advanced',      // protocol permits structured-clone values
  stdio: ['ignore', 'pipe', 'pipe', 'ipc']
})
```

The env allowlist (`plugin-worker-env.ts:8`) is `PATH`, `HOME`, `USERPROFILE`,
`LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`/`TEMP`/`TMP`, plus the Windows vars
libuv needs to resolve DLLs. This **deliberately diverges from the sidecar
precedent**, which spreads the full `process.env` — the app's environment can
carry shell-exported secrets, and third-party code must not inherit them.
Windows keys are folded case-insensitively only on Windows, so an attacker-set
`path` can't be promoted on POSIX.

The plugin's default export receives the `orca` API
(`plugin-host-runtime.ts:20`):

```ts
export default function activate(orca) {
  orca.commands.register(id, handler)   // handler for a manifest-declared command
  orca.events.on(name, handler)          // event the manifest subscribed to
  await orca.host.call(method, params)   // capability-gated host-side
  orca.grantedCapabilities                // informational — the host re-gates
  orca.log(message)
}
```

An optional `deactivate` export runs on shutdown.

**Budgets** (`plugin-host-protocol.ts:108`, `plugin-host-process.ts:18`):

| Bound | Value |
|---|---|
| Concurrent active workers | 5 (`PLUGIN_WORKER_MAX_ACTIVE_DEFAULT`) |
| Activation → `ready` | 10s, then SIGKILL |
| Command invoke | 30s |
| Event handler | 5min, then SIGKILL |
| Pending events | 64, then SIGKILL |
| Idle reap | 5min |
| Shutdown grace | 2s, then SIGKILL |

Slots are leased FIFO through `PluginWorkerSlotPool`; failures back off through
`runPluginWorkerRestartLoop` under supervision.

### 6.2 Panel

The host wraps plugin HTML in a shell **prepended** before the plugin's own
markup (`plugin-panel-shell.ts:20`). Prepending is load-bearing: a CSP `<meta>`
applies the moment it parses and cannot be un-applied by later markup or DOM
removal, and a second CSP from the plugin can only *intersect*, never loosen.

```
default-src 'none'; connect-src 'none'; script-src 'unsafe-inline';
style-src 'unsafe-inline'; img-src data:; font-src data:;
base-uri 'none'; form-action 'none'
```

An opaque-origin sandboxed iframe *without* a CSP can still `fetch()`
CORS-permissive endpoints and beacon data out via `<img>`. This closes that.

The shell also enforces **documents, never browsing contexts**: `window.open` is
hard-nulled, all `<a href>` clicks and form submits are cancelled in the capture
phase, and the Navigation API's `navigate` event is prevented.

Panels see a curated **20-token** subset of the design system
(`PANEL_DESIGN_TOKEN_ALLOWLIST`) — deliberately not all ~257 custom properties
in `main.css`, since freezing every token as public API would lock future
refactors. Grow it additively; renaming or dropping an entry is a plugin-facing
break.

**Bridge budgets** (`plugin-panel-bridge.ts:22`), per qualified plugin identity
across all its panel sessions:

- 64KB per message; 30 messages / 10s sliding window
- oversized and malformed traffic still spends rate budget, so it can't force
  unbounded size-estimation work for free
- a reserved 1KB control lane for liveness, size-bounded only — a per-window
  count there would be spent by the panel's own pongs and drop the next genuine
  reply, which is the starvation the lane exists to prevent
- watchdog pings every 10s; a missed 5s pong deadline demotes the panel to an
  errored badge

Capability enforcement happens **in main, never in the renderer**. The renderer
is a transport that relays `plugins:panelAction`; main re-validates params
against the same spec table and re-checks capabilities.

## 7. Discovery, install, and trust

### 7.1 Install layout

```
<userData>/plugins/<publisher>.<id>/current    ← text file naming the hash
<userData>/plugins/<publisher>.<id>/<hash>/    ← immutable install tree
<userData>/plugins-data/                       ← storage, secrets, audit, kill list
```

Discovery reads manifests and checks **only declared artifact paths** — never
plugin bytes or whole trees. Full content hashing stays lazy so startup cost is
bounded by installed plugins plus declared entries
(`plugin-discovery.ts:26`). Installed manifests are read through a bounded
concurrency pool of 8.

A corrupt `current` pointer that looks path-like is refused outright, and a
manifest whose identity disagrees with its install directory is rejected — two
directories must never claim the same plugin.

Dev plugins load from arbitrary local dirs and **win** over an installed plugin
of the same identity (that's the point of dev mode), but two dev paths colliding
is an error. `PluginDevWatcher` debounces manifest/panel reloads, and the
worker spawn spec includes the parsed manifest so hot reload can't reuse a
worker with stale contributions (`plugin-worker-spawn-spec.ts:18`).

### 7.2 Sources

| Kind | Notes |
|---|---|
| `local-path` | requires `orca-plugin.json` at the root |
| `git` | HTTPS or SSH only; `ref` = branch, tag, or full SHA |
| `marketplace` | git source resolved through an index; re-verifies the previewed commit |
| `bundled` | shipped in `resources/plugins/launch/`; cannot be removed |

Git operations shell out to **system git** via `execFile` with argv arrays —
never a shell string, and never a vendored checkout, so private repos work with
the user's existing credential helpers and SSH remotes
(`plugin-install.ts:37`).

> **No script execution during install, ever — the installer copies files,
> nothing more.**

Installs land in immutable hash-addressed directories behind an atomic pointer
swap; the previous version dir is retained for one-step rollback. Rollback
restores the old consent fingerprint, so enablement still fails closed until the
user approves those exact bytes. Mutations per `pluginsDir` are serialized
through a promise chain.

Artifact caps (`plugin-artifact-validation.ts:9`): worker entry 50MB, panel
10MB, language pack 5MB, icon 2MB, agent profile 1MB, VM recipe 256KB. Every
declared path is resolved through `realpath` and must stay inside the plugin
root — symlink escapes are rejected. `.git` is excluded from the staged tree.

### 7.3 Consent

The fingerprint covers **capabilities + worker trust tier + instructional
content hash** (`plugin-consent-fingerprint.ts:24`):

```
canonicalCapabilitySet  +  "\0trusted-node-worker"?  +  "\0instructional-content:<hash>"?
```

Capability canonicalization is order- and duplicate-insensitive and key-sorted,
so consent is stable across manifest reformatting and no future scoped field can
produce two encodings of the same grant.

A panel-only update that merely adds `main` crosses a trust boundary even with
an unchanged capability list — and re-prompts. Approval is submitted with the
`reviewedFingerprint` the dialog rendered, so it can never apply to a different
same-key plugin (`plugin-consent-request.ts`). The dialog snapshots the plugin
on open (`useRef(currentPlugin).current`) so a same-key update can't swap the
trust boundary mid-review, and initial focus goes to **Keep disabled** — the
safety-preserving path.

### 7.4 Reserved identities

`stablyai.*` or `*.orca-*` are reserved (`plugin-install-trust.ts`):

- bundled sources must match an official `stablyai.orca-*` identity
- reserved identities can never be installed from a local path
- reserved identities from git must resolve to the `stablyai` GitHub org

Marketplace JSON cannot self-award `official` or `bundled` — that metadata is
host-derived, and `bundled` implies `official` by schema refinement.

### 7.5 Revocation

A kill list is fetched from `https://onorca.dev/plugins/kill-list.json`
(`plugin-kill-list-service.ts:10`) and disables installed plugins remotely by
qualified key, with a reason and optional HTTPS advisory URL.

Two subtleties worth preserving:

- a far-future `generatedAt` would make every genuine later list look "older"
  and disable revocation permanently, so freshly fetched snapshots are rejected
  beyond a 24h skew — but **cached** lists are not re-judged against the device
  clock, which would drop live revocations whenever that clock runs slow
- `PluginContentPackRegistry.reconcile` re-reads revocation as the **last** gate
  before publication, because the approved-keys snapshot predates an awaited
  content verification and a kill arriving during that wait would otherwise
  still publish (`plugin-content-pack-registry.ts:65`)

## 8. Host surfaces

### 8.1 Desktop IPC

`src/main/ipc/plugins.ts` — `list`, `listLanguagePacks`, `consent`, `setEnabled`,
`readPanelEntry`, `panelAction`, `invokeCommand`, `install`, `remove`,
`getLogs`, `refresh`. Marketplace handlers add `listMarketplaces`,
`addMarketplace`, `removeMarketplace`, `refreshMarketplaces`,
`listMarketplacePlugins`, `previewMarketplacePlugin`,
`installMarketplacePlugin`, `previewMarketplaceUpdate`,
`rollbackMarketplacePlugin`.

`readPanelEntry` returns CSP-wrapped **file contents**, never a `file://` path,
because the renderer mounts panels as an iframe `srcdoc`.

### 8.2 Runtime RPC (headless `orca serve` / paired clients)

`src/main/runtime/rpc/methods/plugins.ts` — `plugins.list`, `plugins.consent`,
`plugins.setEnabled`, `plugins.panelAction`, `plugins.readPanelEntry`,
`plugins.invokeCommand`. Both routes execute through `PluginService`'s single
chokepoint, so a permission decision can never differ between a local window and
a paired client. Headless serve has no consent dialog, so `plugins.consent` is
the only way a pending plugin becomes active on a server.

`plugins.panelAction` takes `z.unknown()` on purpose: raw admission must run
before strict schema parsing so malformed and oversized traffic can't bypass the
panel budget. Panel session owners are keyed by connection so a bearer session
can't cross paired-client sockets.

### 8.3 Renderer

- **Right sidebar** — panel tabs keyed `plugin:<publisher>.<id>/<panelId>`
- **Jump palette** — contributed commands as quick actions
  (`WorktreeJumpPalette.tsx:1169`)
- **Shortcuts settings** — plugin command keybindings are user-rebindable, keyed
  `plugin:<pluginKey>/<commandId>`
- **Settings → Plugins** — install, consent, enable/disable, logs, marketplace,
  rollback, remove, dev paths

### 8.4 Translatable chrome

A language pack could otherwise rewrite the very copy someone reads to decide
whether to trust a plugin. `plugin-translatable-chrome.ts` protects consent
surfaces by default and allowlists translatable paths explicitly — trust badges,
promises about what plugins may do, trust-event failure copy, and destructive
confirmations stay untranslatable. The list is exact paths rather than a
pattern so anything new stays protected until someone deliberately opts it in.

## 9. Limitations

### 9.1 Workers are not sandboxed

The capability model gates the **host API only**. The worker is a plain Node
process with full filesystem, network, and `child_process` access. What is
actually restricted is the environment allowlist and `execArgv` — that's it.

The consent dialog says so in plain language
(`PluginConsentDialog.tsx:205`):

> "These permissions limit how the plugin uses Orca's API. Its worker still runs
> as a normal process on your computer with full access to your files, network,
> and other processes."

Installing a worker plugin is trusting the publisher. Treat the capability list
as disclosure, not enforcement.

### 9.2 Panels are severely constrained

- **No network whatsoever** — `connect-src 'none'` plus `default-src 'none'`.
  No `fetch`, XHR, WebSocket, or beacons.
- No external scripts, styles, fonts, or images; `data:` only
- No bundler and no npm — a panel is one self-contained HTML file
- No navigation, no `window.open`, no working links, no form submits
- **3 of 13** host methods are panel-callable. No storage, secrets, settings, or
  events from a panel.
- 20 design tokens; no React, no shadcn primitives — hand-written DOM
- **Right sidebar only.** No editor pane, main area, status bar, title bar, or
  context menus.

### 9.3 The extension surface is small and closed

- **3 events.** No file, git, terminal-output, task, or PR events. Payloads are
  bounded projections, never raw runtime objects, so remotes, credentials, and
  absolute repo paths beyond the worktree's own cannot leak
  (`plugin-events.ts:4`).
- **15 built-in actions** for declarative command aliases
  (`plugin-command-actions.ts:5`) — sidebar toggles, history nav, rename, tasks
  view. The set is closed so aliases cannot target component-private shortcut
  implementations.
- **Themes, icons, terminal themes, and skills were deferred.** `contributes` is
  `.strict()`, so a manifest declaring one fails install wholesale. The shared
  marketplace index still advertises such packs, so those listings are filtered
  client-side (`plugin-marketplace.ts:19`).
- **`contributes.agents` is inert** — validated, size-capped, and consent-covered,
  but no registry consumes it. The only reference outside the schema is
  `plugin-artifact-validation.ts:60`.
- No plugin-to-plugin API. Plugins implement extension points; they cannot
  define them.
- `settings:own` is a KV store with **no settings UI schema** — plugins cannot
  render a settings pane.

### 9.4 No build step, no dependencies

The installer copies files. No `npm install`, no compilation, no postinstall.
Vendor everything, or ship a single file.

### 9.5 Trust is TOFU, not signing

No code signing and no publisher verification. What exists instead: an exact
resolved commit pinned in the lockfile, a content hash naming the install dir, a
consent fingerprint that forces re-review on any trust-boundary change, reserved
identity enforcement, and remote kill-list revocation.

### 9.6 Remote install is desktop-only

Consent, enablement, listing, panel actions, and command invocation all have RPC
equivalents. **Install, remove, rollback, logs, and marketplace management do
not.** A paired client can approve and run a plugin on the host; it cannot
install one.

### 9.7 Keybinding conflicts disable both plugins

Two approved plugins claiming the same chord in overlapping contexts are *both*
excluded from the active set, and both get an error
(`plugin-command-registry.ts:93`). There is no precedence or user resolution UI.

## 10. Startup cost

`PluginService.initialize()` is a **lazy kernel**: it discovers manifests only —
no worker forks, no panel reads. Zero plugin code runs before an explicit
trigger (`src/main/index.ts:2614`).

The isolated unit gate asserts P95 under 50ms with 20 approved content packs and
verifies `workerFactory` was never called and no activation marker file exists
(`plugin-startup-budget.test.ts:93`). The app-level e2e gate
(`tests/e2e/plugin-startup-budget.spec.ts`) checks `readyToShow` regression
rather than re-asserting the same number.

## 11. Naming collision

Three unrelated things in this repo are called "plugins". Only the first is this
feature.

| Path | What it actually is |
|---|---|
| `src/main/plugins/`, `src/shared/plugins/` | **Orca plugins** — this document |
| `src/relay/plugin-overlay.ts` | agent-status extensions installed into remote OpenCode/Pi/OMP homes over SSH |
| `src/main/skills/claude-plugin-*.ts` | discovery of **Claude Code** plugin skill sources |

## 12. Reference files

| Concern | File |
|---|---|
| Manifest schema | `src/shared/plugins/plugin-manifest.ts` |
| Capability set + consent copy | `src/shared/plugins/plugin-capabilities.ts` |
| Host API spec table | `src/shared/plugins/plugin-host-api.ts` |
| Panel CSP shell | `src/shared/plugins/plugin-panel-shell.ts` |
| Panel postMessage protocol | `src/shared/plugins/plugin-panel-bridge.ts` |
| Event payloads | `src/shared/plugins/plugin-events.ts` |
| Consent fingerprint | `src/shared/plugins/plugin-consent-fingerprint.ts` |
| Service composition root | `src/main/plugins/plugin-service.ts` |
| Discovery | `src/main/plugins/plugin-discovery.ts` |
| Installer | `src/main/plugins/plugin-install.ts` |
| Worker fork + supervision | `src/main/plugins/plugin-host-process.ts` |
| Worker SDK message loop | `src/main/plugins/plugin-host-runtime.ts` |
| Capability enforcement | `src/main/plugins/plugin-host-method-bindings.ts` |
| Desktop IPC | `src/main/ipc/plugins.ts` |
| Runtime RPC | `src/main/runtime/rpc/methods/plugins.ts` |
| Sample plugins | `examples/plugins/hello-orca/`, `examples/plugins/hostile-panel/` |
| Bundled plugins | `resources/plugins/launch/` |
