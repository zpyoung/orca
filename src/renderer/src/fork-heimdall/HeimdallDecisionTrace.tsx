import { AlertTriangle, ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { WatcherTickTrace } from '../../../shared/fork-heimdall/tick-trace'
import { formatHeimdallJson, formatHeimdallTime } from './fleet-format'

function Decision({ trace }: { trace: WatcherTickTrace }): React.JSX.Element {
  if (!trace.decision) {
    return (
      <span className="text-muted-foreground">
        {translate('fork.heimdall.trace.noDecision', 'No decision recorded')}
      </span>
    )
  }
  if (trace.decision.action) {
    return (
      <span>
        {translate('fork.heimdall.trace.decidedAction', 'Act: {{action}}', {
          action: trace.decision.action.kind
        })}
      </span>
    )
  }
  return (
    <div>
      <span>{trace.decision.reason}</span>
      {trace.decision.detail ? (
        <span className="text-muted-foreground"> · {trace.decision.detail}</span>
      ) : null}
      {trace.decision.considered.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          {trace.decision.considered.map((phase) => (
            <li key={`${phase.phase}:${phase.reason}:${phase.detail ?? ''}`}>
              {phase.phase}: {phase.reason}
              {phase.detail ? ` · ${phase.detail}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function HeimdallDecisionTrace({
  traces
}: {
  traces: readonly WatcherTickTrace[]
}): React.JSX.Element {
  if (traces.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate('fork.heimdall.trace.empty', 'No decision traces yet.')}
      </p>
    )
  }
  return (
    <ol className="space-y-2">
      {[...traces]
        .sort((a, b) => b.seq - a.seq)
        .map((trace, index) => (
          <li key={trace.seq}>
            <details
              className="group rounded-md border border-border bg-muted/10"
              open={index === 0}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <ChevronDown
                  className="size-3.5 shrink-0 transition-transform group-open:rotate-180"
                  aria-hidden
                />
                <span className="font-medium">
                  {translate('fork.heimdall.trace.tick', 'Tick {{seq}}', { seq: trace.seq })}
                </span>
                <time
                  className="text-muted-foreground"
                  dateTime={new Date(trace.startedAtMs).toISOString()}
                >
                  {formatHeimdallTime(trace.startedAtMs)}
                </time>
                <span className="ml-auto text-muted-foreground">
                  {trace.exitPath ?? translate('fork.heimdall.trace.running', 'Running')}
                </span>
              </summary>
              <div className="grid gap-3 border-t border-border px-3 py-3 text-xs lg:grid-cols-3">
                <section>
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                    {translate('fork.heimdall.trace.saw', 'Saw')}
                  </h4>
                  {trace.snapshot ? (
                    <pre className="mt-1 max-h-40 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[10px]">
                      {formatHeimdallJson(trace.snapshot)}
                    </pre>
                  ) : (
                    <p className="mt-1 text-muted-foreground">
                      {translate('fork.heimdall.trace.noSnapshot', 'No snapshot recorded')}
                    </p>
                  )}
                </section>
                <section>
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                    {translate('fork.heimdall.trace.decided', 'Decided')}
                  </h4>
                  <div className="mt-1">
                    <Decision trace={trace} />
                  </div>
                  {trace.gate ? (
                    <p className="mt-2 text-muted-foreground">
                      {translate('fork.heimdall.trace.gate', 'Gate')}: {trace.gate.verdict}
                      {'reason' in trace.gate ? ` · ${trace.gate.reason}` : ''}
                    </p>
                  ) : null}
                </section>
                <section>
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                    {translate('fork.heimdall.trace.declined', 'Declined')}
                  </h4>
                  {trace.declined.length > 0 ? (
                    <ul className="mt-1 space-y-1">
                      {trace.declined.map((phase) => (
                        <li key={`${phase.phase}:${phase.reason}:${phase.detail ?? ''}`}>
                          <span className="font-medium">{phase.phase}</span>: {phase.reason}
                          {phase.detail ? ` · ${phase.detail}` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-muted-foreground">
                      {translate('fork.heimdall.trace.noneDeclined', 'No phase declined')}
                    </p>
                  )}
                  {trace.error ? (
                    <p className="mt-2 flex items-start gap-1.5 text-destructive" role="alert">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {trace.error.message}
                    </p>
                  ) : null}
                </section>
              </div>
            </details>
          </li>
        ))}
    </ol>
  )
}
