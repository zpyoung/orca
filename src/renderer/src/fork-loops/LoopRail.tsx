import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { LoopsApi } from '../../../shared/fork-loops/api'
import type { IterationSummary, LoopSnapshot } from '../../../shared/fork-loops/loop-types'
import { LoopEditForm } from './LoopEditForm'
import { LoopIterationDetail, LoopResumeWithMoreIterations } from './LoopIterationDetail'
import { LoopQueueEditor } from './LoopQueueEditor'
import {
  IterationRow,
  LastCheck,
  LoopMeters,
  loopPill,
  PILL_BASE,
  phaseLabel,
  presetSummary,
  SECTION_HEADING,
  skippedTicksLabel,
  unverifiableHint
} from './loop-rail-parts'
import { selectLoopForPaneKey } from './loops-slice'

export type LoopRailPlacement = 'side' | 'bottom'

type PanelMode = 'steer' | 'edit' | 'stop' | null

const RAIL_BASE =
  'scrollbar-sleek flex flex-col gap-3 overflow-y-auto bg-background p-3 text-sm text-foreground'
const RAIL_PLACEMENT: Record<LoopRailPlacement, string> = {
  side: 'absolute inset-y-0 right-0 w-80 border-l border-border',
  bottom: 'absolute inset-x-0 bottom-0 h-72 border-t border-border'
}

function LoopRailPanel({
  loop,
  placement
}: {
  loop: LoopSnapshot
  placement: LoopRailPlacement
}): React.JSX.Element {
  const applyLoopSnapshot = useAppStore((state) => state.applyLoopSnapshot)
  const [mode, setMode] = useState<PanelMode>(null)
  const [steerText, setSteerText] = useState('')
  const [openIteration, setOpenIteration] = useState<Pick<
    IterationSummary,
    'n' | 'attempt'
  > | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (call: (api: LoopsApi) => Promise<LoopSnapshot>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      applyLoopSnapshot(await call(window.api.loops))
      setMode(null)
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : translate('fork.loops.rail.actionFailed', 'That did not go through. Try again.')
      )
    } finally {
      setBusy(false)
    }
  }

  const ended = loop.state === 'completed' || loop.state === 'stopped'
  const canResume = loop.state === 'paused'
  const iterations = loop.recentIterations.toReversed()
  const pill = loopPill(loop)
  const skippedTicks = skippedTicksLabel(loop)
  const hint = unverifiableHint(loop)
  const detailIteration =
    openIteration === null
      ? undefined
      : loop.recentIterations.find(
          (iteration) =>
            iteration.n === openIteration.n && iteration.attempt === openIteration.attempt
        )
  const resume =
    loop.state === 'paused' && loop.pauseReason === 'cap-iterations' ? (
      <LoopResumeWithMoreIterations
        busy={busy}
        onResume={(addIterations) => void run((api) => api.resume(loop.id, { addIterations }))}
      />
    ) : (
      <Button size="sm" disabled={busy} onClick={() => void run((api) => api.resume(loop.id))}>
        {translate('fork.loops.rail.action.resume', 'Resume')}
      </Button>
    )

  return (
    <aside
      data-placement={placement}
      aria-label={translate('fork.loops.rail.label', 'Loop')}
      className={cn(RAIL_BASE, RAIL_PLACEMENT[placement])}
    >
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h2 className="min-w-0 truncate text-sm font-semibold" title={loop.name}>
            {loop.name}
          </h2>
          <span className={cn(PILL_BASE, pill.tone)}>{pill.label}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">{presetSummary(loop)}</p>
        {skippedTicks ? <p className="text-xs text-muted-foreground">{skippedTicks}</p> : null}
        {hint ? <p className="text-xs text-status-warning-foreground">{hint}</p> : null}
        {loop.currentIteration ? (
          <p className="text-xs text-muted-foreground">{phaseLabel(loop.currentIteration.phase)}</p>
        ) : null}
      </header>

      <LoopMeters loop={loop} />

      {loop.pendingQuestion ? (
        <section className="space-y-2 rounded-md border border-status-warning-border bg-status-warning-background p-2 text-status-warning-foreground">
          <h3 className={SECTION_HEADING}>
            {loop.pendingQuestion.kind === 'decide'
              ? translate('fork.loops.rail.question.decide', 'Decision needed')
              : translate('fork.loops.rail.question.blocked', 'Blocked')}
          </h3>
          <p className="text-xs break-words whitespace-pre-wrap">{loop.pendingQuestion.text}</p>
          {canResume ? resume : null}
        </section>
      ) : null}

      {ended ? null : (
        <div className="flex flex-wrap gap-2">
          {canResume && !loop.pendingQuestion ? resume : null}
          {loop.state === 'running' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run((api) => api.pause(loop.id, 'after-iteration'))}
            >
              {translate('fork.loops.rail.action.pause', 'Pause')}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setMode('steer')}>
            {translate('fork.loops.rail.action.steer', 'Steer…')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMode('edit')}>
            {translate('fork.loops.rail.action.edit', 'Edit')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMode('stop')}>
            {translate('fork.loops.rail.action.stop', 'Stop')}
          </Button>
        </div>
      )}

      {mode === 'stop' ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {translate('fork.loops.rail.stop.prompt', 'Stop the loop')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run((api) => api.stop(loop.id, 'after-iteration'))}
            >
              {translate('fork.loops.rail.stop.afterIteration', 'After this iteration')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void run((api) => api.stop(loop.id, 'now'))}
            >
              {translate('fork.loops.rail.stop.now', 'Now')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMode(null)}>
              {translate('fork.loops.rail.action.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {mode === 'steer' ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            const text = steerText.trim()
            if (text) {
              void run(async (api) => {
                const snapshot = await api.steer(loop.id, text)
                setSteerText('')
                return snapshot
              })
            }
          }}
        >
          <Textarea
            aria-label={translate('fork.loops.rail.steer.label', 'Steering note')}
            placeholder={translate(
              'fork.loops.rail.steer.placeholder',
              'Guidance for the next iteration'
            )}
            value={steerText}
            onChange={(event) => setSteerText(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || steerText.trim() === ''}>
              {translate('fork.loops.rail.steer.send', 'Send')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode(null)}>
              {translate('fork.loops.rail.action.cancel', 'Cancel')}
            </Button>
          </div>
        </form>
      ) : null}

      {mode === 'edit' ? (
        <LoopEditForm
          loop={loop}
          busy={busy}
          onSave={(patch) => void run((api) => api.edit(loop.id, patch))}
          onCancel={() => setMode(null)}
        />
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <LoopQueueEditor loop={loop} />

      {detailIteration ? (
        <LoopIterationDetail
          loopId={loop.id}
          iteration={detailIteration}
          onBack={() => setOpenIteration(null)}
        />
      ) : (
        <section className="min-h-0 space-y-1">
          <h3 className={SECTION_HEADING}>
            {translate('fork.loops.rail.iterations.title', 'Iterations')}
          </h3>
          {iterations.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate('fork.loops.rail.iterations.empty', 'No iterations finished yet')}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {iterations.map((iteration) => (
                <li key={`${iteration.n}:${iteration.attempt}`}>
                  <IterationRow
                    iteration={iteration}
                    onOpen={() => setOpenIteration({ n: iteration.n, attempt: iteration.attempt })}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <LastCheck loop={loop} />
    </aside>
  )
}

/**
 * Control rail for the loop bound to a terminal pane; renders nothing when the pane has no loop.
 * `placement` is chosen by the caller from the room beside the terminal.
 */
export function LoopRail({
  paneKey,
  placement = 'side'
}: {
  paneKey: string | null
  placement?: LoopRailPlacement
}): React.JSX.Element | null {
  const loop = useAppStore((state) => (paneKey ? selectLoopForPaneKey(state, paneKey) : undefined))
  return loop ? <LoopRailPanel loop={loop} placement={placement} /> : null
}
