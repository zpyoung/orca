import React from 'react'
import { Repeat } from 'lucide-react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { StateIndicatorTooltip } from '@/components/StateIndicatorTooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { useAppStore } from '@/store'
import type { LoopSnapshot } from '../../../shared/fork-loops/loop-types'

const REPLACEABLE_STATUSES: readonly WorktreeStatus[] = ['active', 'done', 'inactive']

type LoopGlyphState = 'running' | 'needs-you' | 'paused' | 'detached'

const GLYPH_PRIORITY: readonly LoopGlyphState[] = ['needs-you', 'running', 'paused', 'detached']

const ICON_TONE_CLASS: Record<LoopGlyphState, string> = {
  running: 'text-status-success',
  'needs-you': 'text-status-warning',
  paused: 'text-muted-foreground',
  detached: 'text-muted-foreground'
}

function glyphStateOf(loop: LoopSnapshot): LoopGlyphState | null {
  if (loop.state === 'completed' || loop.state === 'stopped') {
    return null
  }
  if (loop.state === 'needs-you') {
    return 'needs-you'
  }
  return loop.detached ? 'detached' : loop.state
}

function stateLabel(state: LoopGlyphState): string {
  switch (state) {
    case 'running':
      return translate('fork.loops.status.glyph.state.running', 'Running')
    case 'needs-you':
      return translate('fork.loops.status.glyph.state.needsYou', 'Needs you')
    case 'paused':
      return translate('fork.loops.status.glyph.state.paused', 'Paused')
    case 'detached':
      return translate('fork.loops.status.glyph.state.detached', 'Detached')
  }
}

function glyphLabel(loop: LoopSnapshot, state: LoopGlyphState): string {
  const max = loop.config.caps.maxIterations
  const values = { n: loop.iterationsCompleted, max, state: stateLabel(state) }
  return max === undefined
    ? translate('fork.loops.status.glyph.tooltip', 'Loop {{n}} · {{state}}', values)
    : translate('fork.loops.status.glyph.tooltipWithCap', 'Loop {{n}}/{{max}} · {{state}}', values)
}

type GlyphLoop = { loop: LoopSnapshot; state: LoopGlyphState }

function isMoreUrgent(state: LoopGlyphState, than: LoopGlyphState): boolean {
  return GLYPH_PRIORITY.indexOf(state) < GLYPH_PRIORITY.indexOf(than)
}

function indexGlyphLoops(loopsById: Record<string, LoopSnapshot>): ReadonlyMap<string, GlyphLoop> {
  const byWorktree = new Map<string, GlyphLoop>()
  for (const loop of Object.values(loopsById)) {
    const state = glyphStateOf(loop)
    const current = byWorktree.get(loop.worktreeId)
    if (state !== null && (!current || isMoreUrgent(state, current.state))) {
      byWorktree.set(loop.worktreeId, { loop, state })
    }
  }
  return byWorktree
}

type GlyphLoopIndex = {
  loopsById: Record<string, LoopSnapshot> | undefined
  byWorktree: ReadonlyMap<string, GlyphLoop>
}

// Why a separate store: one app-store listener per sidebar card is O(cards) work on every app
// store notification; this keeps the app store at one listener however many cards mount.
const glyphLoopIndex = createStore<GlyphLoopIndex>(() => ({
  loopsById: undefined,
  byWorktree: new Map()
}))
let glyphLoopIndexSubscribed = false

function syncGlyphLoopIndex(): void {
  const loopsById = useAppStore.getState().loopsById
  if (loopsById === glyphLoopIndex.getState().loopsById) {
    return
  }
  glyphLoopIndex.setState({ loopsById, byWorktree: indexGlyphLoops(loopsById ?? {}) })
}

function ensureGlyphLoopIndex(): void {
  // Why the method checks: upstream card suites mock useAppStore as a bare selector hook.
  if (
    glyphLoopIndexSubscribed ||
    typeof useAppStore.getState !== 'function' ||
    typeof useAppStore.subscribe !== 'function'
  ) {
    return
  }
  glyphLoopIndexSubscribed = true
  syncGlyphLoopIndex()
  useAppStore.subscribe(syncGlyphLoopIndex)
}

type LoopLaneGlyphProps = {
  announcement: string
  className?: string
  label: string
  state: LoopGlyphState
  loopId: string
  detached: boolean
  interactive?: boolean
}

function LoopLaneGlyph({
  announcement,
  className,
  label,
  state,
  loopId,
  detached,
  interactive = true
}: LoopLaneGlyphProps): React.JSX.Element {
  const icon = <Repeat className={cn('size-[13px]', ICON_TONE_CLASS[state])} aria-hidden="true" />
  const glyph = (
    <span
      className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}
      data-loop-lane=""
      data-loop-state={state}
    >
      {interactive && detached ? (
        <button
          type="button"
          aria-label={translate('fork.loops.status.glyph.open', 'Open loop')}
          className="inline-flex items-center justify-center rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            void window.api.loops.openTab(loopId)
          }}
        >
          {icon}
        </button>
      ) : (
        icon
      )}
      <span className="sr-only">{`${announcement} · ${label}`}</span>
    </span>
  )
  return interactive ? (
    <StateIndicatorTooltip label={label} side="right">
      {glyph}
    </StateIndicatorTooltip>
  ) : (
    glyph
  )
}

/**
 * Worktree-card status glyph for the most urgent live loop in the worktree, or `null` when there is
 * none. A busy agent keeps its own indicator unless the loop needs the user or is detached.
 */
export function useLoopGlyph(
  worktreeId: string,
  status: WorktreeStatus,
  announcement: string,
  className?: string
): React.JSX.Element | null {
  ensureGlyphLoopIndex()
  const picked = useStore(glyphLoopIndex, (index) => index.byWorktree.get(worktreeId) ?? null)
  if (!picked) {
    return null
  }
  const { loop, state } = picked
  if (state !== 'needs-you' && !loop.detached && !REPLACEABLE_STATUSES.includes(status)) {
    return null
  }
  return (
    <LoopLaneGlyph
      announcement={announcement}
      className={className}
      label={glyphLabel(loop, state)}
      state={state}
      loopId={loop.id}
      detached={loop.detached}
    />
  )
}

/** The unread button already owns the tooltip and click, so render the glyph bare inside it. */
export function withLoopGlyph(
  glyph: React.JSX.Element | null,
  fallback: React.JSX.Element
): React.JSX.Element {
  if (!React.isValidElement<LoopLaneGlyphProps>(glyph) || glyph.type !== LoopLaneGlyph) {
    return fallback
  }
  return (
    <span className="transition-opacity group-hover/unread:opacity-0 group-focus-within/unread:opacity-0">
      {React.cloneElement(glyph, { interactive: false })}
    </span>
  )
}
