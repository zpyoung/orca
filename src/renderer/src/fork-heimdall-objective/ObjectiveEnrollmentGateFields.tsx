import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  OBJECTIVE_GATES_MAX,
  OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS
} from '../../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveEnrollmentFieldHelp, objectiveGatesHelp } from './ObjectiveEnrollmentFieldHelp'
import type {
  ObjectiveEnrollmentDraft,
  ObjectiveEnrollmentGateDraft
} from './objective-enrollment-model'

function GateRow({
  gate,
  index,
  disabled,
  onChange,
  onRemove
}: {
  gate: ObjectiveEnrollmentGateDraft
  index: number
  disabled: boolean
  onChange: (gate: ObjectiveEnrollmentGateDraft) => void
  onRemove: () => void
}): React.JSX.Element {
  const nameId = useId()
  const commandId = useId()
  const timeoutId = useId()

  return (
    <div className="grid grid-cols-[1fr_1fr_96px_auto] items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor={nameId} className="text-xs">
          {translate('fork.heimdallObjective.enrollment.gateName', 'Name')}
        </Label>
        <Input
          id={nameId}
          value={gate.name}
          disabled={disabled}
          placeholder="lint"
          className="h-8 text-xs"
          onChange={(event) => onChange({ ...gate, name: event.currentTarget.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={commandId} className="text-xs">
          {translate('fork.heimdallObjective.enrollment.gateCommand', 'Command')}
        </Label>
        <Input
          id={commandId}
          value={gate.command}
          disabled={disabled}
          className="h-8 font-mono text-xs"
          onChange={(event) => onChange({ ...gate, command: event.currentTarget.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={timeoutId} className="text-xs">
          {translate('fork.heimdallObjective.enrollment.gateTimeout', 'Timeout (s)')}
        </Label>
        <Input
          id={timeoutId}
          type="number"
          min="10"
          max="14400"
          step="1"
          value={gate.timeoutSecondsText}
          disabled={disabled}
          placeholder={String(OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS)}
          className="h-8 text-xs tabular-nums"
          onChange={(event) => onChange({ ...gate, timeoutSecondsText: event.currentTarget.value })}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-label={translate('fork.heimdallObjective.enrollment.removeGate', 'Remove gate {{n}}', {
          n: index + 1
        })}
        onClick={onRemove}
      >
        <Trash2 aria-hidden className="size-3.5" />
      </Button>
    </div>
  )
}

export function ObjectiveEnrollmentGateFields({
  draft,
  disabled,
  onDraftChange
}: {
  draft: ObjectiveEnrollmentDraft
  disabled: boolean
  onDraftChange: (draft: ObjectiveEnrollmentDraft) => void
}): React.JSX.Element {
  const atMax = draft.gates.length >= OBJECTIVE_GATES_MAX

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('fork.heimdallObjective.enrollment.gates', 'Gates')}
        </h3>
        <ObjectiveEnrollmentFieldHelp {...objectiveGatesHelp()} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'fork.heimdallObjective.enrollment.gatesHelpLine',
          'Gates run on the integrated branch after every plan node has merged, before review and landing. Put the full test suite and other whole-tree checks here, not in plan nodes.'
        )}
      </p>
      {draft.gates.map((gate, index) => (
        <GateRow
          key={index}
          gate={gate}
          index={index}
          disabled={disabled}
          onChange={(next) =>
            onDraftChange({
              ...draft,
              gates: draft.gates.map((current, currentIndex) =>
                currentIndex === index ? next : current
              )
            })
          }
          onRemove={() =>
            onDraftChange({
              ...draft,
              gates: draft.gates.filter((_gate, currentIndex) => currentIndex !== index)
            })
          }
        />
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 text-xs"
        disabled={disabled || atMax}
        onClick={() =>
          onDraftChange({
            ...draft,
            gates: [...draft.gates, { name: '', command: '', timeoutSecondsText: '' }]
          })
        }
      >
        <Plus aria-hidden className="size-3.5" />
        {translate('fork.heimdallObjective.enrollment.addGate', 'Add gate')}
      </Button>
    </section>
  )
}
