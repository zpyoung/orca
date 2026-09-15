import { useState } from 'react'
import { HelpCircle, Loader2, Radio, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { WatcherWorker } from '../../../shared/fork-heimdall/fleet-types'
import { formatHeimdallAge } from './fleet-format'

export type HeimdallWorkersProps = {
  workers: readonly WatcherWorker[]
  disabled: boolean
  busyKey: string | null
  onAnswer: (worker: WatcherWorker, body: string) => Promise<void>
  onStop: (worker: WatcherWorker) => Promise<void>
}

function workerLivenessLabel(liveness: WatcherWorker['liveness']): string {
  if (liveness === 'live') {
    return translate('fork.heimdall.workers.live', 'Live')
  }
  if (liveness === 'unverifiable') {
    return translate('fork.heimdall.workers.unverifiable', 'Unreachable')
  }
  return translate('fork.heimdall.workers.exited', 'Exited')
}

export function HeimdallWorkers({
  workers,
  disabled,
  busyKey,
  onAnswer,
  onStop
}: HeimdallWorkersProps): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  if (workers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate('fork.heimdall.workers.empty', 'No live workers.')}
      </p>
    )
  }
  return (
    <ul className="space-y-2">
      {workers.map((worker) => {
        const question = worker.question
        const answer = question ? (answers[question.messageId] ?? '') : ''
        const stopKey = `stop-worker:${worker.dispatchId}`
        const answerKey = question ? `answer:${question.messageId}` : ''
        return (
          <li key={worker.dispatchId} className="rounded-md border border-border bg-muted/10 p-3">
            <div className="flex items-start gap-2">
              <Radio className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">{worker.task}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {workerLivenessLabel(worker.liveness)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {worker.lastContactAtMs === null
                    ? translate('fork.heimdall.workers.noContact', 'No confirmed contact')
                    : translate('fork.heimdall.workers.lastContact', 'Last contact {{age}}', {
                        age: formatHeimdallAge(worker.lastContactAtMs)
                      })}
                  {worker.reason ? ` · ${worker.reason}` : ''}
                </p>
              </div>
              {worker.liveness !== 'exited' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={disabled || busyKey !== null}
                  onClick={() => void onStop(worker)}
                >
                  {busyKey === stopKey ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <Square aria-hidden />
                  )}
                  {translate('fork.heimdall.workers.stop', 'Stop')}
                </Button>
              ) : null}
            </div>
            {question ? (
              <form
                className="mt-3 border-t border-border pt-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (answer.trim()) {
                    void onAnswer(worker, answer.trim())
                  }
                }}
              >
                <div className="flex items-start gap-2 text-xs font-medium text-foreground">
                  <HelpCircle
                    className="mt-0.5 size-3.5 shrink-0 text-status-warning"
                    aria-hidden
                  />
                  {question.body}
                </div>
                <Textarea
                  className="mt-2 min-h-20 text-xs"
                  value={answer}
                  disabled={disabled || busyKey !== null}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.messageId]: event.target.value
                    }))
                  }
                  placeholder={translate(
                    'fork.heimdall.workers.answerPlaceholder',
                    'Answer the worker'
                  )}
                  aria-label={translate(
                    'fork.heimdall.workers.answerLabel',
                    'Answer worker question'
                  )}
                />
                <Button
                  type="submit"
                  size="xs"
                  className="mt-2"
                  disabled={disabled || busyKey !== null || !answer.trim()}
                >
                  {busyKey === answerKey ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {translate('fork.heimdall.workers.sendAnswer', 'Send answer')}
                </Button>
              </form>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
