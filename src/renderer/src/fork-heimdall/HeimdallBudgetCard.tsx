import { useState } from 'react'
import { Loader2, Pencil, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { BudgetPolicy, BudgetState } from '../../../shared/fork-heimdall/budget'
import { formatHeimdallDuration } from './fleet-format'

function parseLimit(value: string, multiplier = 1): number | null | undefined {
  if (!value.trim()) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * multiplier) : undefined
}

export type HeimdallBudgetCardProps = {
  policy: BudgetPolicy
  usage: BudgetState
  disabled: boolean
  busy: boolean
  applying: boolean
  onApply: (budget: BudgetPolicy) => Promise<boolean>
}

export function HeimdallBudgetCard({
  policy,
  usage,
  disabled,
  busy,
  applying,
  onApply
}: HeimdallBudgetCardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [activeMinutes, setActiveMinutes] = useState('')
  const [turns, setTurns] = useState('')
  const parsedMinutes = parseLimit(activeMinutes, 60_000)
  const parsedTurns = parseLimit(turns)
  const budgetValid = parsedMinutes !== undefined && parsedTurns !== undefined
  const activePercent =
    policy.wallClockActiveMs === null || policy.wallClockActiveMs === 0
      ? null
      : Math.min(100, (usage.activeMs / policy.wallClockActiveMs) * 100)

  const beginEditing = (): void => {
    setActiveMinutes(
      policy.wallClockActiveMs === null ? '' : String(policy.wallClockActiveMs / 60_000)
    )
    setTurns(policy.turns === null ? '' : String(policy.turns))
    setEditing(true)
  }

  const cancelEditing = (): void => {
    setActiveMinutes('')
    setTurns('')
    setEditing(false)
  }

  return (
    <section aria-labelledby="heimdall-budget-title">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3
          id="heimdall-budget-title"
          className="text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
        >
          {translate('fork.heimdall.budget.title', 'Budget')}
        </h3>
        {!editing ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled || busy}
            onClick={beginEditing}
          >
            <Pencil aria-hidden />
            {translate('fork.heimdall.budget.edit', 'Edit')}
          </Button>
        ) : null}
      </div>
      <div className="rounded-md border border-border bg-muted/10 p-3">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span>{translate('fork.heimdall.budget.activeTime', 'Active time')}</span>
          <span className="tabular-nums">
            {formatHeimdallDuration(usage.activeMs)} /{' '}
            {policy.wallClockActiveMs === null
              ? translate('fork.heimdall.budget.unlimited', 'Unlimited')
              : formatHeimdallDuration(policy.wallClockActiveMs)}
          </span>
        </div>
        {activePercent !== null ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-status-success"
              style={{ width: `${activePercent}%` }}
            />
          </div>
        ) : null}
        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          <span>{translate('fork.heimdall.budget.turns', 'Worker turns')}</span>
          <span className="tabular-nums">
            {usage.turns} / {policy.turns ?? '∞'}
          </span>
        </div>
        {usage.exhausted ? (
          <p className="mt-2 text-xs text-status-warning">
            {translate('fork.heimdall.budget.exhausted', 'Exhausted: {{kind}}', {
              kind: usage.exhausted.kind
            })}
          </p>
        ) : null}
        {editing ? (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="heimdall-active-minutes" className="text-xs">
                  {translate('fork.heimdall.budget.minutesLimit', 'Active minutes limit')}
                </Label>
                <Input
                  id="heimdall-active-minutes"
                  autoFocus
                  type="number"
                  min="0"
                  step="1"
                  value={activeMinutes}
                  disabled={disabled || busy}
                  placeholder={translate('fork.heimdall.budget.unlimited', 'Unlimited')}
                  onChange={(event) => setActiveMinutes(event.target.value)}
                  aria-invalid={parsedMinutes === undefined}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="heimdall-turn-limit" className="text-xs">
                  {translate('fork.heimdall.budget.turnLimit', 'Worker turn limit')}
                </Label>
                <Input
                  id="heimdall-turn-limit"
                  type="number"
                  min="0"
                  step="1"
                  value={turns}
                  disabled={disabled || busy}
                  placeholder={translate('fork.heimdall.budget.unlimited', 'Unlimited')}
                  onChange={(event) => setTurns(event.target.value)}
                  aria-invalid={parsedTurns === undefined}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={disabled || busy || !budgetValid}
                onClick={() => {
                  if (parsedMinutes === undefined || parsedTurns === undefined) {
                    return
                  }
                  void onApply({ wallClockActiveMs: parsedMinutes, turns: parsedTurns }).then(
                    (applied) => {
                      if (applied) {
                        cancelEditing()
                      }
                    }
                  )
                }}
              >
                {applying ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <SlidersHorizontal aria-hidden />
                )}
                {translate('fork.heimdall.budget.apply', 'Apply budget')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={cancelEditing}
              >
                {translate('fork.heimdall.budget.cancel', 'Cancel')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
}
