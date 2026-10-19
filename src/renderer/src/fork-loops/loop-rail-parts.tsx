import { Check, Minus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import type {
  IterationPhase,
  IterationSummary,
  LoopCaps,
  LoopSnapshot,
  LoopState,
  PauseReason
} from '../../../shared/fork-loops/loop-types'
import { formatLoopDuration } from './LoopIterationDetail'

export const PILL_BASE =
  'inline-flex w-fit shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap'
export const PILL_TONE: Record<LoopState, string> = {
  running: 'border-status-success-border bg-status-success-background text-status-success',
  'needs-you':
    'border-status-warning-border bg-status-warning-background text-status-warning-foreground',
  paused:
    'border-status-warning-border bg-status-warning-background text-status-warning-foreground',
  completed: 'border-status-success-border bg-status-success-background text-status-success',
  stopped: 'border-border bg-muted text-muted-foreground'
}

export const SECTION_HEADING =
  'text-[11px] font-semibold tracking-wider text-muted-foreground uppercase'

export function stateLabel(state: LoopState): string {
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

/** Pill text and tone; an unreachable host outranks the stored state because nothing is advancing. */
export function loopPill(loop: LoopSnapshot): { label: string; tone: string } {
  if (loop.unverifiableSince !== undefined) {
    return {
      label: translate('fork.loops.rail.state.unverifiable', 'Unverifiable'),
      tone: PILL_TONE.paused
    }
  }
  return { label: stateLabel(loop.state), tone: PILL_TONE[loop.state] }
}

export function unverifiableHint(loop: LoopSnapshot): string | null {
  return loop.unverifiableSince === undefined
    ? null
    : translate(
        'fork.loops.rail.unverifiableHint',
        'The agent host is unreachable, so the loop is not advancing.'
      )
}

export function skippedTicksLabel(loop: LoopSnapshot): string | null {
  if (loop.skippedTicks <= 0) {
    return null
  }
  return loop.skippedTicks === 1
    ? translate('fork.loops.rail.skippedTicks_one', '{{count}} tick skipped', {
        count: loop.skippedTicks
      })
    : translate('fork.loops.rail.skippedTicks_other', '{{count}} ticks skipped', {
        count: loop.skippedTicks
      })
}

export function phaseLabel(phase: IterationPhase): string {
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

export function presetSummary(loop: LoopSnapshot): string {
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

function CostMeter({
  loop,
  ofCap
}: {
  loop: LoopSnapshot
  ofCap: (spent: string, cap: string) => string
}): React.JSX.Element | null {
  const { maxCostUsd } = loop.config.caps
  const label = translate('fork.loops.rail.meter.cost', 'Cost')
  if (maxCostUsd === undefined) {
    return loop.costUsd === undefined ? null : (
      <Meter label={label} text={formatUsd(loop.costUsd)} percent={null} />
    )
  }
  if (loop.pauseReason === 'cap-cost' && loop.pauseDetail === 'usage-unavailable') {
    return (
      <Meter
        label={label}
        text={translate('fork.loops.rail.meter.costUnavailable', 'Cost unavailable')}
        percent={null}
      />
    )
  }
  if (loop.costUsd === undefined) {
    return <Meter label={label} text={ofCap('—', formatUsd(maxCostUsd))} percent={null} />
  }
  return (
    <Meter
      label={label}
      text={ofCap(formatUsd(loop.costUsd), formatUsd(maxCostUsd))}
      percent={percentOf(loop.costUsd, maxCostUsd)}
    />
  )
}

export function LoopMeters({ loop }: { loop: LoopSnapshot }): React.JSX.Element {
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
      <CostMeter loop={loop} ofCap={ofCap} />
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

export function IterationRow({
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

export function LastCheck({ loop }: { loop: LoopSnapshot }): React.JSX.Element | null {
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
