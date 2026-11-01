import { isQoderComposerReady } from './qoder-terminal-readiness'
import { memoizeTitleClassification } from '../../shared/terminal-title-classification-memo'
import { detectAgentStatusFromTitle, type AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  evaluateAgentStateRules,
  hasQuietReadyRules,
  holdsReadyTextToQuiet,
  type AgentStateVerdict
} from './agent-state-rules/agent-state-rules-engine'
import { findPromptAnchorIndexes } from './agent-state-rules/agent-state-text-anchors'
import { isTerminalWaitWhitespace } from './terminal-wait-tail-window'
import { showsIdleTitleAnchor } from './agent-state-rules/agent-state-title-anchors'
import { compiledFromActiveAgentStateRules } from './agent-state-rules/active-agent-state-rules'
import {
  findTerminalWaitBlockedSignal,
  isSettledAfter,
  isUnblockedAfter
} from './agent-state-rules/blocked-text-layer'

// Include Orca ready titles and agents that state rest in words.
const EXPLICIT_IDLE_TITLE_RE = /(^|\s)(ready|idle|done)(\s|$|[.!?])/i

function computeExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  const status = detectAgentStatusFromTitle(title)
  // Agent-name launch titles such as Codex YOLO do not prove readiness.
  return status === 'idle' && (EXPLICIT_IDLE_TITLE_RE.test(title) || showsIdleTitleAnchor(title))
    ? 'idle'
    : null
}

/** Polls and repaints repeat unchanged titles; memoize per rule set so reloads invalidate classification. */
const explicitIdleTitleMemo = compiledFromActiveAgentStateRules(() =>
  memoizeTitleClassification(computeExplicitIdleStatusFromTitle)
)

export function detectExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  return explicitIdleTitleMemo()(title)
}

export function isKnownReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isUnblockedAfter(normalized, findKnownReadyPromptIndex(normalized))
}

/** Codex 0.157 discards input behind its provisional startup header; hold anchors veto ready text. */
export function isKnownReadyPromptSettled(preview: string): boolean {
  const normalized = preview.toLowerCase()
  return isSettledAfter(normalized, findKnownReadyPromptIndex(normalized))
}

/** Agent screen refusals also veto shared text. Quiet-only rules settle here only without an output clock; clocked panes use isQuietReadyScreenBody. */
export function isKnownReadyPromptBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null,
  hasOutputClock: boolean
): boolean {
  if (agent === 'qoder' || agent === 'qoder-cn') {
    return isQoderComposerReady(readScreenLines())
  }
  // With an output clock, this agent settles only after quiet.
  if (hasOutputClock && holdsReadyTextToQuiet(agent)) {
    return false
  }
  const ruled = evaluateAgentStateRules(agent, {
    readScreenLines,
    readText: () => waitText.toLowerCase(),
    hasOutputClock
  })
  if (ruled !== null) {
    return isStrongIdle(ruled) && (!ruled.requiresQuiet || !hasOutputClock)
  }
  return isKnownReadyPromptSettled(waitText)
}

/** Mid-turn ready screens/text require quiet. Require Muse identity so pasted transcripts and pagers cannot settle unknown panes. */
export function isQuietReadyScreenBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null
): boolean {
  if (hasQuietReadyRules(agent)) {
    const ruled = evaluateAgentStateRules(agent, {
      readScreenLines,
      readText: () => waitText.toLowerCase()
    })
    return ruled !== null && isStrongIdle(ruled) && ruled.requiresQuiet
  }
  return (agent === null || agent === 'muse') && isMuseReadyPromptPreview(waitText)
}

function isStrongIdle(
  verdict: AgentStateVerdict
): verdict is Extract<AgentStateVerdict, { state: 'idle' }> {
  return verdict.state === 'idle' && verdict.strength === 'strong'
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
  // A later live prompt dismisses the modal even mid-turn; Cursor never titles itself idle.
  return dismissedModalIndex !== null && dismissedModalIndex > blockedSignal.index
    ? null
    : blockedSignal
}

// Live idle/busy prompts supersede startup modals; Muse still needs anchors outside agent-state-rules.
function findDismissedStartupModalIndex(normalized: string): number | null {
  const live = findPromptAnchorIndexes(normalized).live
  const muse = findMuseReadyPromptIndex(normalized)
  return live === null || muse === null ? (live ?? muse) : Math.max(live, muse)
}

function findKnownReadyPromptIndex(normalized: string): number | null {
  const anchored = findPromptAnchorIndexes(normalized).ready
  const claude = findClaudeReadyPromptIndex(normalized)
  return anchored === null || claude === null ? (anchored ?? claude) : Math.max(anchored, claude)
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

// Muse keeps its bare-cwd OSC title; its composer (❯ under a rule, labeled "voice input" only where voice exists) proves readiness.
const MUSE_COMPOSER_RE = /\u2500\u2500\s*\u276F/

function findMuseReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('muse code')
  if (headerIndex === -1) {
    return null
  }
  const segment = normalized.slice(headerIndex)
  const voiceComposer =
    segment.includes('voice') && segment.includes('input') && segment.includes('❯')
  return voiceComposer || MUSE_COMPOSER_RE.test(segment) ? headerIndex : null
}
