import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { IterationDetail } from '../../../shared/fork-loops/api'
import type { IterationSummary } from '../../../shared/fork-loops/loop-types'

/** Formats a span as `45s`, `3m 05s`, or `2h 10m`. */
export function formatLoopDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function iterationCheckLabel(checkPass: boolean | null): string {
  if (checkPass === null) {
    return translate('fork.loops.rail.check.none', 'No check')
  }
  return checkPass
    ? translate('fork.loops.rail.check.passed', 'Check passed')
    : translate('fork.loops.rail.check.failed', 'Check failed')
}

function endReasonLabel(endReason: IterationSummary['endReason']): string {
  switch (endReason) {
    case 'settled':
      return translate('fork.loops.rail.endReason.settled', 'Finished')
    case 'crashed':
      return translate('fork.loops.rail.endReason.crashed', 'Agent crashed')
    case 'interrupted':
      return translate('fork.loops.rail.endReason.interrupted', 'Interrupted')
    case 'stopped':
      return translate('fork.loops.rail.endReason.stopped', 'Stopped')
    case null:
      return translate('fork.loops.rail.endReason.running', 'In progress')
  }
}

function DetailRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-xs text-foreground">{children}</dd>
    </div>
  )
}

type IterationOutputState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; detail: IterationDetail | null }

/** Fetches the stored check output and agent output tail for one iteration attempt. */
function useIterationOutput(
  loopId: string,
  iteration: Pick<IterationSummary, 'n' | 'attempt'>
): IterationOutputState {
  const [state, setState] = useState<IterationOutputState>({ status: 'loading' })
  const { n, attempt } = iteration
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    window.api.loops
      .iterations(loopId)
      .then((details) => {
        if (!cancelled) {
          const detail = details.find((d) => d.n === n && d.attempt === attempt) ?? null
          setState({ status: 'ready', detail })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'failed' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [loopId, n, attempt])
  return state
}

function OutputBlock({ label, text }: { label: string; text: string }): React.JSX.Element {
  return (
    <div className="mt-2">
      <h4 className="text-xs text-muted-foreground">{label}</h4>
      <pre
        tabIndex={0}
        aria-label={label}
        className="mt-1 scrollbar-sleek max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-foreground"
      >
        {text}
      </pre>
    </div>
  )
}

function IterationOutput({ state }: { state: IterationOutputState }): React.JSX.Element | null {
  if (state.status === 'loading') {
    return (
      <p role="status" className="mt-2 text-xs text-muted-foreground">
        {translate('fork.loops.rail.detail.loading', 'Loading output…')}
      </p>
    )
  }
  if (state.status === 'failed') {
    return (
      <p role="alert" className="mt-2 text-xs text-destructive">
        {translate(
          'fork.loops.rail.detail.loadFailed',
          'Could not load the output for this iteration.'
        )}
      </p>
    )
  }
  const { detail } = state
  if (detail === null) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        {translate('fork.loops.rail.detail.noRecord', 'No output was recorded for this iteration.')}
      </p>
    )
  }
  const check = detail.check
  return (
    <>
      {detail.evaluator ? (
        <div className="mt-2">
          <h4 className="text-xs text-muted-foreground">
            {translate('fork.loops.rail.detail.evaluatorReason', 'Evaluator reason')}
          </h4>
          <p className="mt-1 text-xs text-foreground">{detail.evaluator.reason}</p>
        </div>
      ) : null}
      {check?.ran && check.stdoutTail !== '' ? (
        <OutputBlock
          label={translate('fork.loops.rail.detail.checkStdout', 'Check output')}
          text={check.stdoutTail}
        />
      ) : null}
      {check?.ran && check.stderrTail !== '' ? (
        <OutputBlock
          label={translate('fork.loops.rail.detail.checkStderr', 'Check errors')}
          text={check.stderrTail}
        />
      ) : null}
      {detail.outputTail ? (
        <OutputBlock
          label={translate('fork.loops.rail.detail.outputTail', 'Agent output')}
          text={detail.outputTail}
        />
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {translate('fork.loops.rail.detail.noOutput', 'No agent output was captured.')}
        </p>
      )}
    </>
  )
}

/** Everything the loop recorded for one iteration, with a way back to the list. */
export function LoopIterationDetail({
  loopId,
  iteration,
  onBack
}: {
  loopId: string
  iteration: IterationSummary
  onBack: () => void
}): React.JSX.Element {
  const output = useIterationOutput(loopId, iteration)
  const duration =
    iteration.endedAt === null ? null : formatLoopDuration(iteration.endedAt - iteration.startedAt)
  return (
    <section
      aria-label={translate('fork.loops.rail.detail.title', 'Iteration {{n}}', { n: iteration.n })}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {translate('fork.loops.rail.detail.title', 'Iteration {{n}}', { n: iteration.n })}
        </h3>
        <Button variant="ghost" size="xs" onClick={onBack}>
          <ArrowLeft aria-hidden />
          {translate('fork.loops.rail.detail.back', 'Back')}
        </Button>
      </div>
      <dl className="mt-1 divide-y divide-border">
        <DetailRow label={translate('fork.loops.rail.detail.outcome', 'Outcome')}>
          {endReasonLabel(iteration.endReason)}
        </DetailRow>
        <DetailRow label={translate('fork.loops.rail.detail.check', 'Done check')}>
          {iterationCheckLabel(iteration.checkPass)}
        </DetailRow>
        {iteration.evaluatorVerdict !== null ? (
          <DetailRow label={translate('fork.loops.rail.detail.evaluator', 'Evaluator')}>
            {iteration.evaluatorVerdict === 'met'
              ? translate('fork.loops.rail.detail.evaluatorMet', 'Condition met')
              : translate('fork.loops.rail.detail.evaluatorNotMet', 'Condition not met')}
          </DetailRow>
        ) : null}
        <DetailRow label={translate('fork.loops.rail.detail.changes', 'Changes')}>
          {iteration.added === null || iteration.removed === null ? (
            translate('fork.loops.rail.detail.noChanges', 'Not measured')
          ) : (
            <span className="flex justify-end gap-2">
              <span>
                {translate('fork.loops.rail.detail.added', '{{value}} added', {
                  value: iteration.added
                })}
              </span>
              <span>
                {translate('fork.loops.rail.detail.removed', '{{value}} removed', {
                  value: iteration.removed
                })}
              </span>
            </span>
          )}
        </DetailRow>
        {duration !== null ? (
          <DetailRow label={translate('fork.loops.rail.detail.duration', 'Duration')}>
            {duration}
          </DetailRow>
        ) : null}
        {iteration.costUsd !== null ? (
          <DetailRow label={translate('fork.loops.rail.detail.cost', 'Cost')}>
            ${iteration.costUsd.toFixed(2)}
          </DetailRow>
        ) : null}
      </dl>
      <IterationOutput state={output} />
    </section>
  )
}

const DEFAULT_ADDED_ITERATIONS = 5

/** Resume control for a loop paused at its iteration cap: raises the cap by N, then continues. */
export function LoopResumeWithMoreIterations({
  busy,
  onResume
}: {
  busy: boolean
  onResume: (addIterations: number) => void
}): React.JSX.Element {
  const [value, setValue] = useState(String(DEFAULT_ADDED_ITERATIONS))
  const count = Number(value)
  const valid = value.trim() !== '' && Number.isInteger(count) && count >= 1
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">+</span>
      <Input
        className="w-16"
        inputMode="numeric"
        aria-label={translate('fork.loops.rail.resume.addLabel', 'Iterations to add')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <span className="text-xs text-muted-foreground">
        {translate('fork.loops.rail.resume.iterations', 'iterations')}
      </span>
      <Button size="sm" disabled={busy || !valid} onClick={() => onResume(count)}>
        {translate('fork.loops.rail.action.resume', 'Resume')}
      </Button>
    </div>
  )
}
