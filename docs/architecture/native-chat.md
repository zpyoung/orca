# Native Chat (the experimental "Chat UI" view)

> Engineer onboarding reference for the `experimentalNativeChat` feature — the
> chat surface you can flip a supported agent terminal into.

## 1. What it is (the one-paragraph version)

**Native Chat renders a running coding-agent's conversation as a real chat UI —
message bubbles, a composer, tool-call cards, diffs, interactive approval cards —
layered on top of the ordinary terminal pane that hosts the agent.** The agent
(Claude Code, Codex, Grok, OpenClaude) keeps running unchanged inside its PTY.
Native Chat never launches or owns an agent runtime: it **reads** the agent's
on-disk JSONL transcript (plus live hook state) to reconstruct the conversation,
and **writes** your replies back into the same PTY as if you had typed them into
the TUI. It is gated behind an experimental flag and is only offered on terminals
that actually run an agent whose transcript we can parse.

The single most important mental model:

> **The terminal is the source of truth. The chat view is a read/write skin over
> it.** History comes from the transcript file; live progress comes from the
> agent status hook; your input goes out as framed keystrokes to the PTY.

## 2. Feature gating

### The flags

| Setting | Type | Default | Where |
|---|---|---|---|
| `experimentalNativeChat` | `boolean` | `false` | `src/shared/types.ts:2742`, default `src/shared/constants.ts:261` |
| `openAgentTabsInChatByDefault` | `boolean` | `false` | `src/shared/types.ts:2740`, default `src/shared/constants.ts:260` |

Both are surfaced in **Settings → Experimental → "Chat UI"**
(`src/renderer/src/components/settings/NativeChatExperimentalSetting.tsx`). The
master switch toggles `experimentalNativeChat`; when it's on, a **Default view**
`Select` ("Terminal chat" vs "Chat UI") writes `openAgentTabsInChatByDefault`.

### When is the toggle even offered?

`canToggleNativeChat()` in
`src/renderer/src/components/native-chat/native-chat-availability.ts:38` is the
single gate. It returns `true` only when **all** of:

1. `experimentalNativeChatEnabled === true`, **and**
2. `contentType === 'terminal'` (never editor/browser/other surfaces), **and**
3. the tab runs a **supported agent** — resolved with precedence
   `detectedAgent ?? launchAgent ?? resolvedAgent`:
   - `detectedAgent` — live agent-status identity (authoritative; covers
     manually-started or resumed agents),
   - `launchAgent` — what Orca launched in the terminal,
   - `resolvedAgent` — terminal-title resolution, filling only the pre-hook gap.
4. for **Grok**, the transcript must additionally be locally readable
   (`nativeChatTranscriptIsLocalReadable`).

**Exception:** a pane already in chat mode (`isChatViewMode === true`) may always
toggle *back* to terminal, even if live hook identity was lost across a dev/app
restart.

### Supported agents

`NATIVE_CHAT_SUPPORTED_AGENTS = { claude, openclaude, codex, grok }`
(`src/shared/native-chat-agent-support.ts`). The *transcript format* is resolved
separately by `resolveNativeChatTranscriptAgent()`:

- `claude` and `openclaude` → **`claude`** format (OpenClaude writes the Claude
  transcript layout while keeping its own launch/UI identity),
- `codex` → `codex`, `grok` → `grok`.

Each format has its own line decoder: `transcript-line-decoders-{claude,codex,grok}.ts`,
dispatched by `nativeChatLineDecoderForAgent()`
(`src/main/native-chat/transcript-tail-reader.ts:25`). Gemini and plain shells
never qualify.

## 3. The conversation model (the heart of the feature)

Everything renders from one IPC-serializable contract in
`src/shared/native-chat-types.ts`. It must stay plain JSON (no class instances,
`Map`s, or `Date`s) because it crosses the process boundary.

```ts
type NativeChatMessage = {
  id: string                 // stable across re-reads/appends → dedup + list key
  role: 'user' | 'assistant' | 'tool' | 'reasoning' | 'system'
  blocks: NativeChatBlock[]  // text | tool-call | tool-result | image-ref
  timestamp: number | null   // epoch ms, null sorts first (some scrape segments)
  source: 'transcript' | 'hook' | 'scrape'
  turnId?: string            // same turnId ⇒ same turn, regardless of id
}
```

### Three representable sources, ranked

The shared contract can represent messages from three places.
`NATIVE_CHAT_SOURCE_PRIORITY` makes precedence a single lookup:

| Source | Priority | Meaning |
|---|---|---|
| `transcript` | 3 | Authoritative on-disk JSONL history. Wins. |
| `hook` | 2 | Synthetic live content such as the in-flight assistant preview. |
| `scrape` | 1 | Approximate messages parsed from terminal scrollback. |

The normal desktop live-session path currently ingests **transcript** messages.
Hook state supplies status and `lastAssistantMessage`; `NativeChatView` derives a
synthetic streaming message from that preview and removes it once the transcript
catches up. The scrollback scraper exists in `native-chat-scrape-fallback.ts`,
but it is not wired into normal conversation loading.

There are two related merge layers:

1. `mergeNativeChatMessagesWith` in `src/shared/native-chat-merge.ts` handles
   incremental frames. It deduplicates by `id`; a re-emitted id replaces in
   place only when the incoming source is at least as authoritative
   (`priority[incoming] >= priority[current]`). New ids append in arrival order.
2. `assembleNativeChatSession` in `native-chat-session-assembler.ts` builds the
   final ordered session. It deduplicates by `id` and by logical turn
   (`turnId`, otherwise role + normalized content) across different sources,
   keeping the higher-priority copy.

The streaming hook preview does not rely on the id-merger to be superseded. Its
visibility is derived separately from whether it still leads the transcript.

### Turn lifecycle & session status

- `NativeChatTurnLifecycle` — a **provider-authored** turn boundary recovered from
  the transcript itself: `working | completed | interrupted`. This is explicit
  evidence (not inferred from prose) used to reconcile a dropped final hook.
- `NativeChatSessionStatus` — `loading | ready | working | empty | error`, the
  status the view renders.

## 4. Architecture at a glance

```
                         ┌──────────────────────── main process ────────────────────────┐
  agent writes JSONL ──► │  transcript-watch → resolve file → install watcher            │
  transcript on disk     │  transcript-tail-reader → per-agent line decoder → Message[]  │
                         │  ipc/native-chat.ts  (readSession / subscribe / unsubscribe)  │
                         └───────────────▲───────────────────────────┬──────────────────┘
                                         │ nativeChat:readSession     │ nativeChat:appended
                                         │ nativeChat:subscribe       │ (snapshot|replacement|appended)
                         ┌───────────────┴───────────────────────────▼──────────────────┐
                         │                       renderer                                │
  agent status hook ──►  │  use-native-chat-live-session  (read window + live tail)      │
  (lastAssistantMessage) │    ├─ merger (id-dedup, source precedence, windowed)          │
                         │    ├─ incremental assembler (suffix-extension fast path)      │
                         │    └─ mergeNativeChatLiveSession (hook status → session status)│
                         │  NativeChatView → MessageList / Composer / InteractiveCard    │
                         │  native-chat-runtime-send  ──── framed keystrokes ───────────►│──► PTY
                         └───────────────────────────────────────────────────────────────┘
```

Code lives in three mirrored trees:

- `src/renderer/src/components/native-chat/` — the UI + renderer data hooks (~140 files).
- `src/main/native-chat/` — transcript resolution, file watching, per-agent decoding (~30 files).
- `src/shared/native-chat-*.ts` — cross-process contracts: message model, merge,
  streaming, agent support/profiles, ask/answer, slash commands, session options.

## 5. Main-process side: producing messages

### Reading (windowed)

`nativeChat:readSession` (an `ipcMain.handle`, `src/main/ipc/native-chat.ts:277`)
returns the **most-recent window** of decoded messages via
`readNativeChatTranscriptTail`.
`DESKTOP_READ_WINDOW = 300` (`native-chat.ts:32`) — only the recent window is
parsed so a huge transcript never stalls the main process or the list.
Pagination raises `limit`. Args: `{ agent, sessionId, limit?, transcriptPath? }`;
`transcriptPath` (from the hook's providerSession) locates the file when the
session id no longer names it (recent Claude Code).

### Watching (live tail)

`nativeChat:subscribe` (an `ipcMain.on`) calls `subscribeNativeChatTranscript`
(`src/main/native-chat/transcript-watch.ts`), which:

1. resolves the session's file path (`resolveSessionFilePath`),
2. installs a native FS watcher (`installTranscriptWatcher`),
3. decodes appended lines with the per-agent decoder.

A brand-new session's transcript can take **seconds to minutes** to flush its
first line (issue #8401). Instead of failing, the watcher enters a **resolve-poll
loop** (`INITIAL_RESOLVE_POLL_MS = 500` backing off to `MAX_RESOLVE_POLL_MS =
5000`), returns a subscription immediately, and reports `watching: true` so the
renderer stays in `loading` rather than settling a permanent error.

### The push contract

The watcher pushes `nativeChat:appended` frames (`NativeChatAppendedPayload`,
`native-chat.ts:57`), each echoing the renderer-minted `subscriptionId`:

| Frame | When | Semantics |
|---|---|---|
| `snapshot` | initial drain | Authoritative base generation. May carry `error`. |
| `replacement` | inode/file rotation | New authoritative base; repaints history. |
| `appended` | tail growth | Incremental messages to merge onto the base. |

All three may carry a `lifecycle` marker.

### Subscription lifetime (leak safety)

Subscriptions are keyed by **`(webContents.id, subscriptionId)`** so one renderer
can watch several panes. Teardown is strict (plan risk U4):

- a `pending` map guards async setup so `unsubscribe` / window-destroy /
  same-id resubscribe can invalidate a watcher *before* it publishes,
- `sender.once('destroyed', …)` tears down **every** watcher a closed/reloaded
  window owns (fd-leak prevention).

## 6. Renderer side: assembling the live session

`useNativeChatLiveSession`
(`src/renderer/src/components/native-chat/use-native-chat-live-session.ts`) is
where a pane becomes a `NativeChatSession`. It runs two axes in parallel:

- **Base read** — windowed `readSession`; result *replaces* the base list.
- **Live tail** — `subscribe`; `snapshot`/`replacement` reset the base,
  `appended` frames accumulate in a **separate** list so a re-read never drops
  in-flight appends.

Key internals:

- **`appended` merger** (`createNativeChatMerger`, `src/shared/native-chat-merge.ts`)
  — stateful id-dedup that caches an `id → index` map, so each live frame costs
  `O(incoming)` instead of `O(existing+incoming)`, then bounds to the read window
  (`boundNativeChatWindow`).
- **Incremental assembler** (`native-chat-incremental-assembler.ts`) — when the
  new transcript is a pure suffix-extension of the last (`sharesPrefix`), it
  splices just the tail; otherwise it fully resets so the cache can't drift.
- **notFound retry** — a not-yet-flushed transcript retries on backoff
  `[1s, 2s, 4s, 8s]` then fixed `10s`, capped at a `60s` window (#8401), staying
  in `loading` instead of erroring.
- **Pagination** — `loadEarlier` raises `limit` and re-reads a larger window
  (the read is an ordered tail, so older history prepends). Stale resolves from a
  swapped session / flipped owner / superseded epoch are discarded.
- **Transport per owner (Model B)** — `getNativeChatSessionTransport(runtimeEnvironmentId)`
  routes read/subscribe to the **remote host** for a runtime-owned (SSH/remote)
  pane, or keeps the local IPC path. An owner flip changes transport identity and
  re-subscribes against the new host. (Note the web RPC bridge returns a Promise
  unsubscribe, unlike the desktop sync fn — the effect cleanup handles both.)

The final `useMemo` folds live hook state into a session status via
`mergeNativeChatLiveSession`.

## 7. Streaming preview & live status precedence

While a turn is in flight the transcript hasn't been written yet, so we show a
**synthetic streaming bubble** from the hook's `lastAssistantMessage`:

- `deriveNativeChatStreamingText` (`src/shared/native-chat-streaming.ts`) returns
  the preview **only while `working` and it leads the transcript** (longer than,
  and not already contained in, the last assistant turn). Once the real turn
  catches up, the preview is suppressed so the bubble doesn't duplicate or flicker.
- The synthetic message has a stable id `'streaming'` and `source: 'hook'`.

Session-status precedence lives in `liveStatusOverride`
(`native-chat-live-status.ts`), and is deliberately **hook-first**:

- only hook `'working'` drives a live override (blocked/waiting/done leave the
  derived ready/empty status alone);
- it stays authoritative **until** the hook leaves `working` **or** an explicit
  terminal lifecycle marker (`completed`/`interrupted`) for *this* turn lands —
  lifecycle is a suppressor for dropped Stop hooks, not a full turn reconstructor;
- an `interrupted` marker ends the whole turn (children included);
- Claude's **background subagents** keep the aggregate turn `working` even after
  the lead turn completes (`hookHasWorkingSubagents`);
- transcript vs hook clocks get `2s` skew slack over SSH/runtime, applied only to
  real epoch timestamps.

## 8. The send path (user → PTY)

Because we're writing into a live TUI, sends are careful and **serialized per
PTY** (`native-chat-pty-send-queue.ts`). The pure byte-builders live in
`native-chat-send.ts`; the IO orchestration in `native-chat-runtime-send.ts`.

### Plain message — `sendNativeChatMessage`

1. **Clear** any unsubmitted TUI line with Ctrl+U (`\x15`) so a prior cancelled
   paste can't glue onto this prompt.
2. **Paste** the framed body (`buildNativeChatPasteBytes`).
3. **Delayed Enter** as a *separate* write after `NATIVE_CHAT_SUBMIT_DELAY_MS` —
   a same-write CR can be swallowed by the paste.

### Optimistic echo — no flash while IPC catches up

Before the transcript reflects the send, the message is shown from a local
**pending cache** (`native-chat-pending.ts`, sessionStorage-backed):
`appendPendingSendCache` → `pendingSendsAsMessages`. When the real turn arrives,
`prunePendingSends` removes the echo. The same file handles **command markers**
(slash-command echoes) and the **launch prompt** shown before the first turn.

### Verified path — `sendNativeChatMessageVerified`

Session-option commands (model switch, `/effort`, …) must not be disrupted by a
stray delayed Enter. This path **cancels any in-flight chat send on the PTY,
waits for idle**, then uses `sendRuntimePtyInputVerified` (awaits remote/SSH
acceptance) for body and Enter. This is why opening Claude's "Switch model?"
dialog no longer eats a chat Enter. Ordinary slash/skill tokens use the normal
serialized send path; verified delivery is specific to the session-option
command flow.

### Interactive answers — `sendNativeChatAskAnswer`

Some agents render a **digit-commit question selector** that ignores pasted label
text (pasting "Blue"+Enter commits the highlighted *first* option — STA-1860):
Claude's AskUserQuestion and Codex 0.145's `request_user_input`. For these
(`shouldStepNativeChatAskAnswer`), answers are delivered as **paced per-option
keystroke groups**, one group per `NATIVE_CHAT_QUESTION_STEP_MS`, so the
arrow-navigate selector applies each before the next. Image attachments have their
own settle-timed variant (`sendNativeChatMessageWithImageAttachments`).

## 9. Session effort and other session options

Effort is **not** read from or written to the conversation transcript. Native
Chat models it as a model-scoped session option, keeps a best-known local record,
and changes the running agent through its PTY. The record tags each value by how
it was learned:

| Source | Meaning |
|---|---|
| `applied` | Orca emitted the value into the agent's launch command. |
| `dispatched` | Chat sent a live command, but has not independently confirmed the resulting TUI state. |
| `reported` | Chat read the value back from an authoritative agent surface. |
| `unknown` | Chat cannot truthfully identify the current value. |

The record is cached by live PTY id, with the terminal tab id as the launch-time
fallback (`native-chat-session-option-cache.ts`). Options are model-scoped
because changing models can reset effort and other modes.

### Reading effort

At launch, `resolveNativeChatSessionOptionDefaults` reads the user's persisted
model and model-specific values from `settings.nativeChatSessionOptions`.
`resolveAgentSessionOptionLaunch` translates supported values into CLI arguments
and returns only the values that were actually applied. Launch flows seed those
values into the session-option cache, so explicit trailing agent arguments that
override Orca's flags do not produce false UI state.

For an already-running session:

- **Claude:** `readClaudeSessionOptionsFromTerminalScreen` parses the fixed TUI
  header for the current model and text such as `with high effort`. The hook
  prefers a main-buffer snapshot when it is authoritative; while the TUI owns
  the alternate screen, it falls back to the mounted xterm serialization.
  Parsed values enter the record as `reported`.
- **Codex:** there is no equivalent live effort reporter. Chat can show a value
  seeded from an Orca launch, but otherwise the current value is `unknown`.
  Opening Codex's model picker clears stale model and effort truth because Chat
  cannot observe which choice the user makes.

This is a point-in-time session-option read, not a transcript subscription.

### Writing effort

The composer renders descriptors from `useNativeChatSessionOptions`. Choosing a
settable value calls `surface.setOption('effort', value)`, which serializes
option changes per surface and applies the agent catalog's mid-session behavior:

- **Claude:** builds `/effort <value>` and sends it through
  `sendNativeChatMessageVerified`. The verified path drains pending chat writes,
  sends the command body, waits, and sends Enter separately through the owning
  local/SSH/runtime PTY. After terminal acceptance, the cache records the value
  as `dispatched`; the picker communicates that it was sent but not confirmed
  until a later authoritative report.
- **Codex:** effort is an `agent-picker` operation rather than a direct command.
  Chat sends `/model`, clears its prior model-scoped truth, switches to the
  terminal, and lets the user choose model and reasoning effort in Codex's TUI.
  Native Chat does not infer the resulting selection.

The picker is disabled while the agent is working or another option update is in
flight, preventing option commands from interleaving with ordinary chat sends.
OpenClaude and Grok currently have no session-option catalog, so they expose no
effort control.

### Persisted defaults and future launches

A successfully dispatched absolute selection is also persisted under the
agent's selected model in `settings.nativeChatSessionOptions`. Future launches
resolve that default and emit:

- Claude: `--effort <value>`
- Codex: `-c model_reasoning_effort=<value>`

The launch command places these generated flags before the user's free-form
agent arguments, so an explicit user-supplied effort flag remains the final,
winning override. No effort path edits the transcript or provider session file.

## 10. Rendering layer

Mounted by `NativeChatView` (default export,
`src/renderer/src/components/native-chat/NativeChatView.tsx`), which resolves the
agent/session through `NativeChatSessionGate` and renders `NativeChatResolvedView`.

| Component | Role |
|---|---|
| `NativeChatMessageList` | Scroll container; autoscroll, pagination trigger, "jump to latest". `MessageRow` renders each message. |
| `NativeChatComposer` / `…ComposerField` / `…ComposerActions` | Input, image-paste previews, attach/dictate/send-stop/session-options. |
| `NativeChatInteractiveCard` | Renders agent questions and approvals. A question replaces the composer because it supplies its own answer input; an approval renders alongside the composer. |
| `NativeChatToolRun` | Collapsible tool-call/result summary. |
| `NativeChatDiffView` | Colored file-edit diffs (git-decoration tokens). |
| `NativeChatEmptyState` | Loading / error / empty / unsupported-pane states. |
| `NativeChatAutocompleteMenus` | Slash-command & skill picker, mention hints. |

### Width and horizontal layout

Native Chat does not measure its width in JavaScript. The portal wrapper uses
`absolute inset-0`, and `NativeChatView` uses `w-full`, so the outer chat surface
always fills the owning terminal split pane.

The transcript and composer then establish the same centered readable column:

- their outer region supplies horizontal padding (`px-3`, or `sm:px-4`);
- their content uses `mx-auto w-full` plus the configured width class.

The cap is user-selectable. `GlobalSettings.nativeChatWidth` holds one of four
named tiers, which `native-chat-width.ts` maps to a Tailwind token:

| Tier | Class | Cap |
|---|---|---|
| `narrow` | `max-w-2xl` | `42rem` (`672px`) |
| `comfortable` | `max-w-4xl` | `56rem` (`896px`) — default |
| `wide` | `max-w-6xl` | `72rem` (`1152px`) |
| `full` | `max-w-none` | uncapped; fills the pane minus padding |

The resulting base width is:

```text
content width = min(pane width - 2 × horizontal padding, tier cap)
```

The setting is global rather than per-pane, so every open chat pane changes
together. Two controls write it — a `Select` in Settings → Experimental and an
inline `DropdownMenu` (`NativeChatWidthMenu`) in the pane header, shown while the
active pane is in chat view. All four column sites read it through
`useNativeChatWidthClassName`, whose resolver falls back to `comfortable` for
settings that are still loading or predate the feature; the default therefore
leaves the view pixel-identical to before the setting existed.

Horizontal padding is `0.75rem` per side below the `sm` viewport breakpoint and
`1rem` per side at or above it. Tailwind breakpoints follow the application
viewport, not the individual split-pane width, so a narrow split in a wide
window still receives `sm:px-4`. On a wide pane the unused space is divided
evenly by `mx-auto` — which becomes a no-op at the `full` tier.

Assistant rows can use the full readable column. User bubbles and their delivery
errors are capped at `85%` of it (`max-w-[85%]`) and right-aligned, so they track
whichever tier is active.

Chat font zoom applies CSS `zoom` only to the transcript content container. It
scales the transcript's text and layout together; the composer retains its
unscaled column. Width and zoom are orthogonal and compose without special
casing — zoom is per-pane and in-session, width is global and persisted.

Question and approval cards use a subtly different nesting: `mx-auto w-full
px-3 sm:px-4` and the width class sit on the same element. Because the padding is
inside the capped box, their inner card content is narrower by the horizontal
padding at any capped tier. In narrow panes their inner edges still align with
the transcript and composer.

**Role styling** (in `MessageRow`): `user` → right-aligned `bg-muted` bubble;
`assistant` → left-aligned prose via `CommentMarkdown` (variant `"document"`) with
hover copy/scroll controls; `reasoning` → italic left-border aside in muted color;
`system` → small muted text. Built on shadcn primitives
(`src/renderer/src/components/ui/`) + Lucide icons + Tailwind design tokens (see
[`docs/STYLEGUIDE.md`](../STYLEGUIDE.md)). A typing indicator (three bouncing dots)
shows while `working`.

## 11. Mounting & opening

Native Chat is **portaled into the terminal pane's own container** so the terminal
stays mounted and alive behind it:

- `TerminalPane.tsx:2931` — `createPortal(<NativeChatView …/>, chatPane.container)`,
  gated on `effectiveChatViewMode = nativeChatEnabled && isChatViewMode`
  (`TerminalPane.tsx:597`).
- The header toggle button lives in `TerminalPaneHeaderOverlay.tsx` (`onToggleNativeChat`),
  showing `MessageSquare` to enter chat and `SquareTerminal` to return, with
  `aria-pressed` reflecting state.
- Clicking calls `toggleNativeChatForLeaf` (`TerminalPane.tsx:740`). `viewMode`
  is persisted on the unified tab, while component-local `chatLeafId` identifies
  which split pane owns the chat overlay. Entering chat selects that leaf and
  flips the tab mode when needed; leaving clears the leaf and returns the tab to
  terminal mode.

**Opening new tabs in chat by default:** `decideInitialAgentTabViewMode`
(`src/renderer/src/lib/native-chat-initial-view-mode.ts`) returns `viewMode: 'chat'`
only when the flag **and** `openAgentTabsInChatByDefault` are on, the agent is
supported (and Grok-readable), and it isn't a **draft** launch (a draft's prompt
exists only in the TUI input buffer, so it must stay in the terminal).

## 12. Cross-cutting concerns & invariants

- **SSH / remote ownership:** runtime-owned (`runtime:`, Model B) panes read and
  tail on the remote runtime host. Local and `ssh:`-owned (Model A) panes use the
  local adapter; Model A Grok is gated because its remote transcript is not
  locally readable. Never assume local-only file access when adding a transport
  or provider.
- **Windowing everywhere:** base read, live-append tail, and pagination all share
  one window bound so a long run can't grow the list unbounded.
- **Merger vs assembler drift:** the stateful merger's output is locked to equal
  the pure `mergeNativeChatMessagesWith` by an oracle test; any suffix-extension
  miss forces a full assembler reset rather than risking a stale cache.
- **`hookState` is intentionally excluded** from the assembler's memo deps —
  status-only churn must not re-run message assembly.
- **Skill invocations** are user turns Claude records as noise-filtered command
  envelopes; `surfaceSkillInvocationUserTurns` re-surfaces them as the literal
  token.

## 13. Extension points

**Adding a new supported agent:**

1. Add the identity to `NATIVE_CHAT_SUPPORTED_AGENTS` and map its transcript
   format in `resolveNativeChatTranscriptAgent` (`src/shared/native-chat-agent-support.ts`).
2. Write a line decoder `transcript-line-decoders-<agent>.ts` and register it in
   `nativeChatLineDecoderForAgent` (`src/main/native-chat/transcript-tail-reader.ts`).
3. Teach `resolveSessionFilePath` where that agent writes its transcript.
4. If the agent uses a digit-commit question selector, add it to
   `shouldStepNativeChatAskAnswer`.
5. Add model/session-option behavior to the shared agent-session-option catalog;
   add verified slash/skill commands to `native-chat-agent-profiles.ts` when
   applicable.

## 14. Key file reference

| Concern | File |
|---|---|
| Message / session contract | `src/shared/native-chat-types.ts` |
| Id-dedup merge + windowing | `src/shared/native-chat-merge.ts` |
| Streaming-bubble derivation | `src/shared/native-chat-streaming.ts` |
| Agent support / format mapping | `src/shared/native-chat-agent-support.ts` |
| IPC handlers + push payloads | `src/main/ipc/native-chat.ts` |
| Transcript resolve + watch | `src/main/native-chat/transcript-watch.ts` |
| Windowed tail read + decoder dispatch | `src/main/native-chat/transcript-tail-reader.ts` |
| Per-agent decoders | `src/main/native-chat/transcript-line-decoders-{claude,codex,grok}.ts` |
| Live session hook | `src/renderer/src/components/native-chat/use-native-chat-live-session.ts` |
| Hook status → session status | `src/renderer/src/components/native-chat/native-chat-live-status.ts` |
| Availability gate | `src/renderer/src/components/native-chat/native-chat-availability.ts` |
| Send orchestration | `src/renderer/src/components/native-chat/native-chat-runtime-send.ts` |
| Session-option catalog | `src/shared/agent-session-option-catalog-claude-codex.ts` |
| Launch-option translation | `src/shared/agent-session-option-launch.ts` |
| Live option read/surface | `src/renderer/src/components/native-chat/use-native-chat-session-options.ts` |
| Live option application | `src/renderer/src/components/native-chat/native-chat-session-option-apply.ts` |
| Optimistic pending cache | `src/renderer/src/components/native-chat/native-chat-pending.ts` |
| Top-level view | `src/renderer/src/components/native-chat/NativeChatView.tsx` |
| Message list / rows | `src/renderer/src/components/native-chat/NativeChatMessageList.tsx` |
| Composer | `src/renderer/src/components/native-chat/NativeChatComposer.tsx` |
| Settings toggle | `src/renderer/src/components/settings/NativeChatExperimentalSetting.tsx` |
| Initial view-mode decision | `src/renderer/src/lib/native-chat-initial-view-mode.ts` |
| Pane mount / toggle | `src/renderer/src/components/terminal-pane/TerminalPane.tsx` (portal ~`:2931`, toggle `:740`) |

## 15. Related docs

- [`docs/native-chat-codex-tui-parity.md`](../native-chat-codex-tui-parity.md) —
  Codex TUI parity notes.
- [`docs/STYLEGUIDE.md`](../STYLEGUIDE.md) — design tokens the UI must use.
