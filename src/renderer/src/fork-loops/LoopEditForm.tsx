import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import {
  LoopEditPatchSchema,
  type LoopConfig,
  type LoopEditPatch,
  type LoopSnapshot
} from '../../../shared/fork-loops/loop-types'
import {
  CheckboxField,
  LoopSetupAdvancedFields,
  SelectField,
  TextField,
  type FieldError,
  type LoopSetupDraft
} from './LoopSetupAdvancedFields'
import {
  IntervalFields,
  MaxIterationsField,
  PromptField,
  SessionPolicyField,
  useIsFolderWorkspace
} from './loop-config-fields'

type PacingKind = 'on-idle' | 'interval'
type EditDraft = LoopSetupDraft & { pacingKind: PacingKind }

const DEFAULT_INTERVAL_MINUTES = '30'
const DEFAULT_CHECK_TIMEOUT_SECONDS = '300'

const CONFIG_KEYS = [
  'promptSource',
  'pacing',
  'sessionPolicy',
  'done',
  'caps',
  'noProgress',
  'protectedPaths',
  'checkpointCommits',
  'askBeforeNext',
  'resumeAtLimitReset'
] as const satisfies readonly (keyof LoopConfig)[]

const FIELD_ERROR_BY_PATH: Record<string, FieldError> = {
  'pacing.minutes': 'interval',
  'caps.maxIterations': 'iterations',
  'caps.maxActiveMinutes': 'activeMinutes',
  'caps.maxCostUsd': 'cost',
  'done.check.timeoutSeconds': 'checkTimeout'
}

function draftFromLoop(loop: LoopSnapshot): EditDraft {
  const { config } = loop
  const { promptSource, pacing, done, caps } = config
  return {
    name: loop.name,
    agent: loop.agent,
    preset: loop.preset,
    prompt: promptSource.kind === 'repeat' ? promptSource.body : '',
    repeatQueue: promptSource.kind === 'queue' ? promptSource.repeatQueue : false,
    queueItems: [],
    pacingKind: pacing.kind,
    intervalMinutes: pacing.kind === 'interval' ? String(pacing.minutes) : DEFAULT_INTERVAL_MINUTES,
    anchor: pacing.kind === 'interval' ? pacing.anchor : 'from-end',
    sessionPolicy: config.sessionPolicy,
    maxIterations: String(caps.maxIterations ?? ''),
    maxActiveMinutes: String(caps.maxActiveMinutes ?? ''),
    maxCostUsd: String(caps.maxCostUsd ?? ''),
    checkCommand: done.check?.command ?? '',
    checkTimeoutSeconds: String(done.check?.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS),
    checkRunWhen: done.check?.runWhen ?? 'every-iteration',
    evaluatorCondition: done.evaluator?.condition ?? '',
    protectedPaths: (config.protectedPaths ?? []).join('\n'),
    noProgress: config.noProgress,
    checkpointCommits: config.checkpointCommits,
    askBeforeNext: config.askBeforeNext,
    resumeAtLimitReset: config.resumeAtLimitReset
  }
}

/** Empty text means "unset"; anything else that is not a valid number is left for the schema to reject. */
function optionalNumber(text: string): number | undefined {
  return text.trim() === '' ? undefined : Number(text)
}

function configFromDraft(draft: EditDraft, source: LoopConfig): LoopConfig {
  const checkCommand = draft.checkCommand.trim()
  const evaluatorCondition = draft.evaluatorCondition.trim()
  const maxIterations = optionalNumber(draft.maxIterations)
  const maxActiveMinutes = optionalNumber(draft.maxActiveMinutes)
  const maxCostUsd = optionalNumber(draft.maxCostUsd)
  return {
    promptSource:
      source.promptSource.kind === 'queue'
        ? { kind: 'queue', repeatQueue: draft.repeatQueue }
        : { kind: 'repeat', body: draft.prompt.trim() },
    pacing:
      draft.pacingKind === 'interval'
        ? {
            kind: 'interval',
            minutes: optionalNumber(draft.intervalMinutes) ?? Number.NaN,
            anchor: draft.anchor
          }
        : { kind: 'on-idle' },
    sessionPolicy: draft.sessionPolicy,
    done: {
      ...(checkCommand !== ''
        ? {
            check: {
              command: checkCommand,
              timeoutSeconds: optionalNumber(draft.checkTimeoutSeconds) ?? Number.NaN,
              runWhen: draft.checkRunWhen
            }
          }
        : {}),
      ...(evaluatorCondition !== '' ? { evaluator: { condition: evaluatorCondition } } : {})
    },
    caps: {
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(maxActiveMinutes === undefined ? {} : { maxActiveMinutes }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd })
    },
    noProgress: draft.noProgress,
    protectedPaths: draft.protectedPaths
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
    checkpointCommits: draft.checkpointCommits,
    askBeforeNext: draft.askBeforeNext,
    resumeAtLimitReset: draft.resumeAtLimitReset
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
      : nested
  )
}

/** An absent `protectedPaths` and an empty list mean the same thing, so neither counts as a change. */
function withComparableProtectedPaths(config: LoopConfig): LoopConfig {
  return { ...config, protectedPaths: config.protectedPaths ?? [] }
}

type EditOutcome = { patch: LoopEditPatch } | { errors: ReadonlySet<FieldError> }

/** Builds a `LoopEditPatch` holding only what differs from the loop, or reports the invalid fields. */
function buildEditPatch(draft: EditDraft, loop: LoopSnapshot): EditOutcome {
  const next = configFromDraft(draft, loop.config)
  const before = withComparableProtectedPaths(loop.config)
  const patch: LoopEditPatch = {}
  const name = draft.name.trim()
  if (name !== loop.name) {
    patch.name = name
  }
  for (const key of CONFIG_KEYS) {
    if (canonicalJson(next[key]) !== canonicalJson(before[key])) {
      Object.assign(patch, { [key]: next[key] })
    }
  }
  const errors = new Set<FieldError>()
  if (name === '') {
    errors.add('name')
  }
  if (next.promptSource.kind === 'repeat' && next.promptSource.body === '') {
    errors.add('prompt')
  }
  for (const issue of LoopEditPatchSchema.safeParse(patch).error?.issues ?? []) {
    const field = FIELD_ERROR_BY_PATH[issue.path.join('.')]
    if (field) {
      errors.add(field)
    }
  }
  return errors.size > 0 ? { errors } : { patch }
}

/** Edits every setting of a running or paused loop; the queue items and agent stay as created. */
export function LoopEditForm({
  loop,
  busy,
  onSave,
  onCancel
}: {
  loop: LoopSnapshot
  busy: boolean
  onSave: (patch: LoopEditPatch) => void
  onCancel: () => void
}): React.JSX.Element {
  const idPrefix = useId()
  const [draft, setDraft] = useState<EditDraft>(() => draftFromLoop(loop))
  const isFolderWorkspace = useIsFolderWorkspace(loop.worktreeId)
  const update = (patch: Partial<EditDraft>): void => setDraft((d) => ({ ...d, ...patch }))
  const outcome = buildEditPatch(draft, loop)
  const errors = 'errors' in outcome ? outcome.errors : new Set<FieldError>()
  const unchanged = 'patch' in outcome && Object.keys(outcome.patch).length === 0
  const showCost = loop.costUsd !== undefined || loop.config.caps.maxCostUsd !== undefined
  const isQueue = loop.config.promptSource.kind === 'queue'
  const section = { draft, errors, update }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if ('patch' in outcome && !unchanged) {
          onSave(outcome.patch)
        }
      }}
    >
      <TextField
        id={`${idPrefix}-name`}
        label={translate('fork.loops.rail.edit.name', 'Name')}
        value={draft.name}
        error={
          errors.has('name')
            ? translate('fork.loops.rail.edit.errorName', 'Enter a name.')
            : undefined
        }
        onChange={(name) => update({ name })}
      />
      {isQueue ? (
        <CheckboxField
          id={`${idPrefix}-repeat-queue`}
          label={translate('fork.loops.setup.repeatQueue', 'Start over when the queue is empty')}
          checked={draft.repeatQueue}
          onChange={(repeatQueue) => update({ repeatQueue })}
        />
      ) : (
        <PromptField
          {...section}
          idPrefix={idPrefix}
          errorMessage={translate('fork.loops.rail.edit.errorPrompt', 'Enter a prompt.')}
        />
      )}
      <SelectField
        label={translate('fork.loops.rail.edit.pacing', 'Pacing')}
        value={draft.pacingKind}
        options={[
          {
            value: 'on-idle',
            label: translate('fork.loops.rail.edit.pacingOnIdle', 'As soon as the agent is idle')
          },
          {
            value: 'interval',
            label: translate('fork.loops.rail.edit.pacingInterval', 'On an interval')
          }
        ]}
        onChange={(value) => update({ pacingKind: value === 'interval' ? 'interval' : 'on-idle' })}
      />
      {draft.pacingKind === 'interval' ? <IntervalFields {...section} idPrefix={idPrefix} /> : null}
      <SessionPolicyField {...section} />
      <MaxIterationsField {...section} idPrefix={idPrefix} />
      <Collapsible>
        <CollapsibleTrigger variant="row">
          {translate('fork.loops.setup.advanced', 'Advanced')}
          <ChevronDown className="size-4 text-muted-foreground" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <LoopSetupAdvancedFields
            {...section}
            idPrefix={idPrefix}
            showCost={showCost}
            showCheckpointCommits={!isFolderWorkspace}
          />
        </CollapsibleContent>
      </Collapsible>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || unchanged || errors.size > 0}>
          {translate('fork.loops.rail.edit.save', 'Save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {translate('fork.loops.rail.action.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  )
}
