import { useId, useState } from 'react'
import { Check, Minus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { LoopsApi } from '../../../shared/fork-loops/api'
import type {
  IterationPhase,
  IterationSummary,
  LoopCaps,
  LoopSnapshot,
  LoopState,
  PauseReason
} from '../../../shared/fork-loops/loop-types'
import {
  formatLoopDuration,
  LoopIterationDetail,
  LoopResumeWithMoreIterations
} from './LoopIterationDetail'
import { selectLoopForPaneKey } from './loops-slice'

export type LoopRailPlacement = 'side' | 'bottom'

type PanelMode = 'steer' | 'edit' | 'stop' | null

const RAIL_BASE =
  'scrollbar-sleek flex flex-col gap-3 overflow-y-auto bg-background p-3 text-sm text-foreground'
const RAIL_PLACEMENT: Record<LoopRailPlacement, string> = {
  side: 'absolute inset-y-0 right-0 w-80 border-l border-border',
  bottom: 'absolute inset-x-0 bottom-0 h-72 border-t border-border'
}

const PILL_BASE =
  'inline-flex w-fit shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap'
const PILL_TONE: Record<LoopState, string> = {
  running: 'border-status-success-border bg-status-success-background text-status-success',
  'needs-you':
    'border-status-warning-border bg-status-warning-background text-status-warning-foreground',
  paused:
    'border-status-warning-border bg-status-warning-background text-status-warning-foreground',
  completed: 'border-status-success-border bg-status-success-background text-status-success',
  stopped: 'border-border bg-muted text-muted-foreground'
}

const SECTION_HEADING = 'text-[11px] font-semibold tracking-wider text-muted-foreground uppercase'

function stateLabel(state: LoopState): string {
  switch (state) {
    case 'running':
      return translate('fork.loops.rail.state.running', 'Running')
    case 'needs-you':
      return translate('fork.loops.rail.state.needsYou', 'Needs you')
    case 'paused':
      return translate('fork.loops.rail.state.paused', 'Paused')
    case 'completed':
      return translate('fork.loops.rail.state.completed', 'Completed')
    case 'stopped':
      return translate('fork.loops.rail.state.stopped', 'Stopped')
  }
}

function phaseLabel(phase: IterationPhase): string {
  switch (phase) {
    case 'relaunching':
      return translate('fork.loops.rail.phase.relaunching', 'Restarting the agent')
    case 'sending':
      return translate('fork.loops.rail.phase.sending', 'Sending the prompt')
    case 'working':
      return translate('fork.loops.rail.phase.working', 'Agent working')
    case 'needs-you':
      return translate('fork.loops.rail.phase.needsYou', 'Waiting on you')
    case 'checking':
      return translate('fork.loops.rail.phase.checking', 'Running the done check')
    case 'evaluating':
      return translate('fork.loops.rail.phase.evaluating', 'Evaluating the result')
    case 'waiting':
      return translate('fork.loops.rail.phase.waiting', 'Waiting for the next iteration')
  }
}

function pauseReasonLabel(reason: PauseReason): string {
  switch (reason) {
    case 'user':
      return translate('fork.loops.rail.pause.user', 'Paused by you')
    case 'cap-iterations':
      return translate('fork.loops.rail.pause.capIterations', 'Iteration cap reached')
    case 'cap-time':
      return translate('fork.loops.rail.pause.capTime', 'Time cap reached')
    case 'cap-cost':
      return translate('fork.loops.rail.pause.capCost', 'Cost cap reached')
    case 'no-progress':
      return translate('fork.loops.rail.pause.noProgress', 'No progress in recent iterations')
    case 'protected-path':
      return translate('fork.loops.rail.pause.protectedPath', 'Touched a protected path')
    case 'agent-blocked':
      return translate('fork.loops.rail.pause.agentBlocked', 'The agent is blocked')
    case 'agent-decide':
      return translate('fork.loops.rail.pause.agentDecide', 'The agent needs a decision')
    case 'crashed':
      return translate('fork.loops.rail.pause.crashed', 'The agent kept crashing')
    case 'usage-limit':
      return translate('fork.loops.rail.pause.usageLimit', 'Agent usage limit reached')
    case 'interrupted-by-restart':
      return translate(
        'fork.loops.rail.pause.interruptedByRestart',
        'Interrupted by an app restart'
      )
    case 'unverifiable':
      return translate('fork.loops.rail.pause.unverifiable', 'Lost contact with the agent host')
    case 'ask-before-next':
      return translate('fork.loops.rail.pause.askBeforeNext', 'Waiting for your go-ahead')
    case 'queue-exhausted':
      return translate('fork.loops.rail.pause.queueExhausted', 'The queue is empty')
  }
}

function presetSummary(loop: LoopSnapshot): string {
  const { pacing } = loop.config
  const preset =
    loop.preset === 'interval' && pacing.kind === 'interval'
      ? translate('fork.loops.rail.preset.interval', 'Every {{minutes}} min', {
          minutes: pacing.minutes
        })
      : loop.preset === 'queue'
        ? translate('fork.loops.rail.preset.queue', 'Work through a queue')
        : translate('fork.loops.rail.preset.untilDone', 'Until done')
  return `${preset} · ${loop.agent}`
}

function iterationHeadline(loop: LoopSnapshot): string {
  const max = loop.config.caps.maxIterations
  const current = loop.currentIteration?.n
  if (current !== undefined) {
    return max === undefined
      ? translate('fork.loops.rail.iteration.current', 'Iteration {{n}}', { n: current })
      : translate('fork.loops.rail.iteration.currentOfMax', 'Iteration {{n}} of {{max}}', {
          n: current,
          max
        })
  }
  return max === undefined
    ? translate('fork.loops.rail.iteration.done', '{{n}} iterations done', {
        n: loop.iterationsCompleted
      })
    : translate('fork.loops.rail.iteration.doneOfMax', '{{n}} of {{max}} iterations done', {
        n: loop.iterationsCompleted,
        max
      })
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`
}

function percentOf(value: number, cap: number): number {
  return Math.min(100, Math.max(0, (value / cap) * 100))
}

function Meter({
  label,
  text,
  percent
}: {
  label: string
  text: string
  percent: number | null
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span>{text}</span>
      </div>
      {percent === null ? null : <Progress value={percent} aria-label={label} />}
    </div>
  )
}

function LoopMeters({ loop }: { loop: LoopSnapshot }): React.JSX.Element {
  const caps: LoopCaps = loop.config.caps
  const ofCap = (spent: string, cap: string): string =>
    translate('fork.loops.rail.meter.ofCap', '{{spent}} of {{cap}}', { spent, cap })
  return (
    <div className="space-y-2">
      <Meter
        label={iterationHeadline(loop)}
        text=""
        percent={
          caps.maxIterations === undefined
            ? null
            : percentOf(loop.iterationsCompleted, caps.maxIterations)
        }
      />
      {caps.maxActiveMinutes === undefined ? null : (
        <Meter
          label={translate('fork.loops.rail.meter.time', 'Time')}
          text={ofCap(formatLoopDuration(loop.activeMs), `${caps.maxActiveMinutes}m`)}
          percent={percentOf(loop.activeMs, caps.maxActiveMinutes * 60_000)}
        />
      )}
      {loop.costUsd === undefined ? null : (
        <Meter
          label={translate('fork.loops.rail.meter.cost', 'Cost')}
          text={
            caps.maxCostUsd === undefined
              ? formatUsd(loop.costUsd)
              : ofCap(formatUsd(loop.costUsd), formatUsd(caps.maxCostUsd))
          }
          percent={caps.maxCostUsd === undefined ? null : percentOf(loop.costUsd, caps.maxCostUsd)}
        />
      )}
    </div>
  )
}

function CheckBadge({ checkPass }: { checkPass: boolean | null }): React.JSX.Element {
  if (checkPass === null) {
    return (
      <Badge variant="outline">
        <Minus aria-hidden />
        {translate('fork.loops.rail.badge.none', 'No check')}
      </Badge>
    )
  }
  return checkPass ? (
    <Badge variant="outline">
      <Check className="text-status-success" aria-hidden />
      {translate('fork.loops.rail.badge.pass', 'Pass')}
    </Badge>
  ) : (
    <Badge variant="outline">
      <X className="text-destructive" aria-hidden />
      {translate('fork.loops.rail.badge.fail', 'Fail')}
    </Badge>
  )
}

function IterationRow({
  iteration,
  onOpen
}: {
  iteration: IterationSummary
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={translate('fork.loops.rail.detail.title', 'Iteration {{n}}', { n: iteration.n })}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="w-7 shrink-0 text-muted-foreground">#{iteration.n}</span>
      <CheckBadge checkPass={iteration.checkPass} />
      <span className="ml-auto shrink-0 font-mono">
        {iteration.added === null || iteration.removed === null
          ? ''
          : `+${iteration.added} −${iteration.removed}`}
      </span>
      <span className="w-12 shrink-0 text-right text-muted-foreground">
        {iteration.endedAt === null
          ? '…'
          : formatLoopDuration(iteration.endedAt - iteration.startedAt)}
      </span>
    </button>
  )
}

function LastCheck({ loop }: { loop: LoopSnapshot }): React.JSX.Element | null {
  const last = loop.recentIterations.findLast((iteration) => iteration.checkPass !== null)
  const reason = loop.pauseReason ? pauseReasonLabel(loop.pauseReason) : null
  if (!last && !reason && !loop.pauseDetail) {
    return null
  }
  return (
    <section className="space-y-1 rounded-md border border-border bg-card p-2 text-xs text-card-foreground">
      <h3 className={SECTION_HEADING}>
        {translate('fork.loops.rail.lastCheck.title', 'Last check')}
      </h3>
      {last ? (
        <p>
          {last.checkPass
            ? translate('fork.loops.rail.lastCheck.passed', 'Passed in iteration {{n}}', {
                n: last.n
              })
            : translate('fork.loops.rail.lastCheck.failed', 'Failed in iteration {{n}}', {
                n: last.n
              })}
        </p>
      ) : null}
      {reason ? <p className="text-muted-foreground">{reason}</p> : null}
      {loop.pauseDetail ? <p className="break-words">{loop.pauseDetail}</p> : null}
    </section>
  )
}

function LoopEditForm({
  loop,
  busy,
  onSave,
  onCancel
}: {
  loop: LoopSnapshot
  busy: boolean
  onSave: (patch: { name: string; caps: LoopCaps }) => void
  onCancel: () => void
}): React.JSX.Element {
  const idPrefix = useId()
  const [name, setName] = useState(loop.name)
  const [maxIterations, setMaxIterations] = useState(String(loop.config.caps.maxIterations ?? ''))
  const [maxMinutes, setMaxMinutes] = useState(String(loop.config.caps.maxActiveMinutes ?? ''))
  const [maxCost, setMaxCost] = useState(String(loop.config.caps.maxCostUsd ?? ''))

  const parsedIterations = maxIterations.trim() === '' ? undefined : Number(maxIterations)
  const parsedMinutes = maxMinutes.trim() === '' ? undefined : Number(maxMinutes)
  const parsedCost = maxCost.trim() === '' ? undefined : Number(maxCost)
  const invalid =
    name.trim() === '' ||
    (parsedIterations !== undefined &&
      !(Number.isInteger(parsedIterations) && parsedIterations >= 1)) ||
    (parsedMinutes !== undefined && !(Number.isInteger(parsedMinutes) && parsedMinutes >= 1)) ||
    (parsedCost !== undefined && !(parsedCost > 0))

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (invalid) {
          return
        }
        onSave({
          name: name.trim(),
          caps: {
            ...(parsedIterations === undefined ? {} : { maxIterations: parsedIterations }),
            ...(parsedMinutes === undefined ? {} : { maxActiveMinutes: parsedMinutes }),
            ...(parsedCost === undefined ? {} : { maxCostUsd: parsedCost })
          }
        })
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-name`}>{translate('fork.loops.rail.edit.name', 'Name')}</Label>
        <Input id={`${idPrefix}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-iterations`}>
          {translate('fork.loops.rail.edit.maxIterations', 'Max iterations')}
        </Label>
        <Input
          id={`${idPrefix}-iterations`}
          inputMode="numeric"
          value={maxIterations}
          onChange={(e) => setMaxIterations(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-minutes`}>
          {translate('fork.loops.rail.edit.maxMinutes', 'Max active minutes')}
        </Label>
        <Input
          id={`${idPrefix}-minutes`}
          inputMode="numeric"
          value={maxMinutes}
          onChange={(e) => setMaxMinutes(e.target.value)}
        />
      </div>
      {loop.costUsd === undefined && loop.config.caps.maxCostUsd === undefined ? null : (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-cost`}>
            {translate('fork.loops.rail.edit.maxCost', 'Max cost (USD)')}
          </Label>
          <Input
            id={`${idPrefix}-cost`}
            inputMode="decimal"
            value={maxCost}
            onChange={(e) => setMaxCost(e.target.value)}
          />
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || invalid}>
          {translate('fork.loops.rail.edit.save', 'Save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {translate('fork.loops.rail.action.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  )
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
          <span className={cn(PILL_BASE, PILL_TONE[loop.state])}>{stateLabel(loop.state)}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">{presetSummary(loop)}</p>
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

      {detailIteration ? (
        <LoopIterationDetail iteration={detailIteration} onBack={() => setOpenIteration(null)} />
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
