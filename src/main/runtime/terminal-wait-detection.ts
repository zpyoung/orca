import { isQoderComposerReady } from './qoder-terminal-readiness'
import { memoizeTitleClassification } from '../../shared/terminal-title-classification-memo'
import { detectAgentStatusFromTitle, type AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  findCodexHeaderIndex,
  findCodexScreenReadyPromptIndex,
  isCodexComposerReadyScreen,
  isCodexProvisionalStartupText
} from './codex-terminal-readiness'
import { findStartupDialogBlockedSignals } from './startup-dialog-blocked-signals'
import {
  isTerminalWaitWhitespace,
  startOfLastLines,
  startOfLastNonBlankLines
} from './terminal-wait-tail-window'

// Why agent-agnostic: Orca's own `<Agent> ready` titles, and any agent title stating rest in words.
const EXPLICIT_IDLE_TITLE_RE = /(^|\s)(ready|idle|done)(\s|$|[.!?])/i

function computeExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  const status = detectAgentStatusFromTitle(title)
  // Why: launch titles like "Codex YOLO" contain an agent name but aren't readiness signals; terminal.wait needs explicit idle evidence.
  return status === 'idle' && (EXPLICIT_IDLE_TITLE_RE.test(title) || showsIdleTitleAnchor(title))
    ? 'idle'
    : null
}

/**
 * Pure in `title` for one rule set, so it is memoized on the title string like the status
 * classifier it wraps: the wait path re-asks for the same unchanged title on every poll tick and
 * every repaint frame, and the marker scan below is a regex sweep each time (~72ns vs ~7ns). Why a
 * fresh memo per rule set: a rules reload can change which titles read as idle.
 */
const explicitIdleTitleMemo = compiledFromActiveAgentStateRules(() =>
  memoizeTitleClassification(computeExplicitIdleStatusFromTitle)
)

export function detectExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  return explicitIdleTitleMemo()(title)
}

export function isKnownReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isUnblockedAfter(normalized, findPromptAnchorIndexes(normalized).ready)
}

/**
 * The ready-prompt text rules for a pane about to take input. Unlike isKnownReadyPromptPreview
 * (agent presence), nothing counts while a hold anchor shows (Codex's provisional startup header):
 * 0.157 discards input typed behind it while its daemon starts.
 */
export function isKnownReadyPromptSettled(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isReadyPromptSettled(normalized, findKnownReadyPromptIndex(normalized))
}

function isReadyPromptSettled(normalized: string, readyIndex: number | null): boolean {
  return (
    isReadyPromptUnblocked(normalized, readyIndex) && !isCodexProvisionalStartupText(normalized)
  )
}

/**
 * Tier 1 body evidence for every tui-idle site. `readScreenLines` yields the screen the agent's
 * rules read, or null when the runtime has no trustworthy one.
 *
 * Why not for a clocked Codex pane: its header stays up through every turn, so it proves only
 * that Codex started; isQuietReadyScreenBody holds it to quiescence instead.
 * Why a clockless pane keeps it: quiescence needs an output clock, which a restored pane lacks.
 */
export function isKnownReadyPromptBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  hasOutputClock: boolean
): boolean {
  if (agent === 'qoder' || agent === 'qoder-cn') {
    return isQoderComposerReady(readScreenLines())
  }
  if (agent === 'codex' && hasOutputClock) {
    return false
  }
  if (isKnownReadyPromptSettled(waitText)) {
    return true
  }
  // Why the agent gate: another agent's screen can merely mention "OpenAI Codex".
  if (agent !== null && agent !== 'codex') {
    return false
  }
  const screen = readScreen(readScreenLines)
  return screen !== null && isCodexScreenHeaderReady(screen)
}

/**
 * Tier 1b body evidence: a ready screen or text the agent also paints mid-turn, so the ranking
 * holds it to quiescence. Why identified panes only for Muse: a `cat`ed transcript or pager in an
 * unknown pane can show the composer.
 */
export function isQuietReadyScreenBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null
): boolean {
  if (agent === 'codex') {
    const screen = readScreen(readScreenLines)
    if (
      screen !== null &&
      (isCodexComposerReadyScreen(screen) || isCodexScreenHeaderReady(screen))
    ) {
      return true
    }
    // Why the provisional veto here too: a daemon start can stay quiet past the quiescence window.
    const normalized = waitText.toLowerCase()
    return isReadyPromptSettled(normalized, findCodexReadyPromptIndex(normalized))
  }
  return (agent === null || agent === 'muse') && isMuseReadyPromptPreview(waitText)
}

/**
 * Why the screen: Codex repaints its 0.150-0.157 header by cell diff (`ESC[5;3Hdir
 * ESC[5;7Hctory:`), which only a grid reassembles — the line-folded wait text reads `dirctory:`.
 * Why it can only add readiness: a grid out of step with the PTY (size mismatch, resize
 * mid-paint) garbles the header, so the text rule keeps every verdict it gives on its own.
 */
function isCodexScreenHeaderReady(screen: string): boolean {
  return isReadyPromptUnblocked(screen, findCodexScreenReadyPromptIndex(screen))
}

function readScreen(readScreenLines: () => readonly string[] | null): string | null {
  return readScreenLines()?.join('\n').toLowerCase() ?? null
}

function isReadyPromptUnblocked(normalized: string, readyIndex: number | null): boolean {
  if (readyIndex === null) {
    return false
  }
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  return blockedSignal === null || blockedSignal.index <= readyIndex
}

export function isMuseReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isUnblockedAfter(normalized, findMuseReadyPromptIndex(normalized))
}

export function detectTerminalWaitBlockedReason(
  preview: string
): RuntimeTerminalWaitBlockedReason | null {
  const normalized = preview.toLowerCase()
  return findActionableTerminalWaitBlockedSignal(normalized)?.reason ?? null
}

export function findActionableTerminalWaitBlockedSignal(
  normalized: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number } | null {
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  if (blockedSignal === null) {
    return null
  }
  const dismissedModalIndex = findDismissedStartupModalIndex(normalized)
  // Why: a live prompt after the modal means it was dismissed → signal no longer actionable, even mid-run (Cursor never reports idle via OSC title).
  return dismissedModalIndex !== null && dismissedModalIndex > blockedSignal.index
    ? null
    : blockedSignal
}

// Why: a live prompt (idle OR busy) proves the startup modal was dismissed, so a mid-run Cursor lane stops reporting stale trust hits.
// Why Muse beside the rule-file anchors: Muse has not moved to agent-state-rules/ yet.
function findDismissedStartupModalIndex(normalized: string): number | null {
  const indexes = [
    findCodexReadyPromptIndex(normalized),
    findCodexHeaderIndex(normalized),
    findAntigravityReadyPromptIndex(normalized),
    findCursorActivePromptIndex(normalized),
    findMuseReadyPromptIndex(normalized)
  ].filter((index): index is number => index !== null)
  return indexes.length > 0 ? Math.max(...indexes) : null
}

function findKnownReadyPromptIndex(normalized: string): number | null {
  const indexes = [
    findCodexReadyPromptIndex(normalized),
    findAntigravityReadyPromptIndex(normalized),
    findCursorReadyPromptIndex(normalized),
    findClaudeReadyPromptIndex(normalized)
  ].filter((index): index is number => index !== null)
  return indexes.length > 0 ? Math.max(...indexes) : null
}

const CLAUDE_PROMPT_GLYPH = '\u276f'
const CLAUDE_EMPTY_INPUT_PLACEHOLDER = 'try "'
const CLAUDE_SPINNER_ROW_RE = /^[\u00b7\u2722\u2733\u2736\u273b\u273d] \S/
// Why not `thought`: a mid-turn thinking row shares the summary's `<verb> for <duration>` shape.
const CLAUDE_TURN_SUMMARY_RE =
  /^[\u00b7\u2722\u2733\u2736\u273b\u273d] (?!thought )[\p{L}'-]+ for \d/u

// Why the screen: Claude Code paints no idle OSC title. `Try "…"` fills the empty input box only
// before the first turn; after one, the proof is a past-tense summary row (`✻ Brewed for 1s`)
// where the live spinner row (`✶ Flambéing…`) stood. No banner check: SessionStart hook output
// routinely pushes the banner off the visible screen.
function findClaudeReadyPromptIndex(normalized: string): number | null {
  const promptIndex = normalized.lastIndexOf(CLAUDE_PROMPT_GLYPH)
  if (promptIndex === -1) {
    return null
  }
  let cursor = promptIndex + CLAUDE_PROMPT_GLYPH.length
  while (
    cursor < normalized.length &&
    (isTerminalWaitWhitespace(normalized, cursor) || normalized.charCodeAt(cursor) === 0xa0)
  ) {
    cursor += 1
  }
  if (normalized.startsWith(CLAUDE_EMPTY_INPUT_PLACEHOLDER, cursor)) {
    return promptIndex
  }
  return isClaudeInputEmpty(normalized, promptIndex) &&
    endsClaudeTurnWithSummary(normalized, promptIndex)
    ? promptIndex
    : null
}

function isClaudeInputEmpty(normalized: string, promptIndex: number): boolean {
  const lineEnd = normalized.indexOf('\n', promptIndex)
  return (
    normalized
      .slice(promptIndex + CLAUDE_PROMPT_GLYPH.length, lineEnd === -1 ? undefined : lineEnd)
      .trim() === ''
  )
}

/** Whether the last spinner-glyph row since the last submitted prompt is a finished-turn summary. */
function endsClaudeTurnWithSummary(normalized: string, promptIndex: number): boolean {
  const submittedIndex =
    promptIndex > 0 ? normalized.lastIndexOf(CLAUDE_PROMPT_GLYPH, promptIndex - 1) : -1
  const spinnerRows = normalized
    .slice(submittedIndex + 1, promptIndex)
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => CLAUDE_SPINNER_ROW_RE.test(line))
  const lastRow = spinnerRows.at(-1)
  return lastRow !== undefined && CLAUDE_TURN_SUMMARY_RE.test(lastRow)
}

/**
 * Whether a tui-idle wait should read the provider's visible screen.
 *
 * Why Claude even with runtime text: it paints with cursor moves, so what reaches the tail is a
 * few status rows below its prompt box, never the prompt the ready rule needs.
 */
export function tuiIdleNeedsVisibleScreenProbe(
  lastAgentStatus: AgentStatus | null,
  waitText: string,
  agent: string | null | undefined
): boolean {
  return lastAgentStatus === null && (waitText.length === 0 || agent === 'claude')
}

// Why: match the banner's last occurrence to skip the trust dialog's own "Cursor Agent" text; "→" is cursor-agent's persistent input prompt.
function findCursorActivePromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('cursor agent')
  if (headerIndex === -1) {
    return null
  }
  return normalized.includes('→', headerIndex) ? headerIndex : null
}

// Why: cursor-agent emits no idle OSC title; infer idle from the tail (braille spinner = busy, its absence = idle).
const CURSOR_BUSY_SPINNER_RE = /[⠁-⣿]/

function findCursorReadyPromptIndex(normalized: string): number | null {
  const activeIndex = findCursorActivePromptIndex(normalized)
  if (activeIndex === null) {
    return null
  }
  return CURSOR_BUSY_SPINNER_RE.test(normalized.slice(activeIndex)) ? null : activeIndex
}

// Why: Muse titles its OSC with the bare cwd and never updates it, so only the body can
// prove the TUI is up. The voice-input composer is present even without loaded skills.
function findMuseReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('muse code')
  if (headerIndex === -1) {
    return null
  }
  const segment = normalized.slice(headerIndex)
  return segment.includes('voice') && segment.includes('input') && segment.includes('❯')
    ? headerIndex
    : null
}
