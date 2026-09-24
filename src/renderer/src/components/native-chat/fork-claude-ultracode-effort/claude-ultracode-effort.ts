import { translate } from '@/i18n/i18n'

import type { AgentType } from '../../../../../shared/agent-status-types'
import type {
  CatalogModel,
  CatalogOption
} from '../../../../../shared/agent-session-option-catalog-types'
import type { NativeChatSessionOptionRecord } from '../../../../../shared/native-chat-session-option-state'
import { getTrackedSessionOption } from '../../../../../shared/native-chat-session-option-state'
import type {
  SessionOptionSelectChoice,
  SessionOptionValue
} from '../../../../../shared/native-chat-session-options'

/** Claude effort value Orca uses for the session-only Ultracode picker choice. */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode' as const

function ultracodeChoice(): SessionOptionSelectChoice {
  return {
    value: CLAUDE_ULTRACODE_EFFORT,
    label: translate('components.native-chat.claude-ultracode-effort.label', 'Ultracode'),
    description: translate(
      'components.native-chat.claude-ultracode-effort.description',
      'Extra high effort with multi-agent workflows · this session only'
    )
  }
}

function withUltracodeChoice(option: CatalogOption): CatalogOption {
  if (option.id !== 'effort' || option.kind.type !== 'select') {
    return option
  }
  if (!option.kind.choices.some((choice) => choice.value === 'xhigh')) {
    return option
  }
  if (option.kind.choices.some((choice) => choice.value === CLAUDE_ULTRACODE_EFFORT)) {
    return option
  }
  return {
    ...option,
    kind: {
      ...option.kind,
      choices: [...option.kind.choices, ultracodeChoice()]
    }
  }
}

function withoutEffort(
  values: Record<string, SessionOptionValue>
): Record<string, SessionOptionValue> {
  const next = { ...values }
  delete next.effort
  return next
}

/**
 * Returns Claude catalog models with an Ultracode effort choice wherever xhigh is available.
 * Non-Claude agents receive a shallow model-list copy; inputs and seed catalogs are not mutated.
 */
export function withChoice(agent: AgentType, models: readonly CatalogModel[]): CatalogModel[] {
  if (agent !== 'claude') {
    return [...models]
  }
  return models.map((model) => {
    let changed = false
    const options = model.options.map((option) => {
      const next = withUltracodeChoice(option)
      changed ||= next !== option
      return next
    })
    return changed ? { ...model, options } : model
  })
}

/** Returns whether a picked value should be sent only to the live Claude session. */
export function isSessionOnly(
  agent: AgentType,
  optionId: string,
  value: SessionOptionValue
): boolean {
  return agent === 'claude' && optionId === 'effort' && value === CLAUDE_ULTRACODE_EFFORT
}

/**
 * Reconciles Claude reports so Ultracode can remain selected when assistant rows report xhigh.
 * This is an approximation: assistant rows report xhigh under Ultracode, while an out-of-band
 * exit such as raw /effort xhigh, /clear, or a relaunch in the same PTY is not detected here.
 */
export function reconciled(
  record: NativeChatSessionOptionRecord,
  values: Record<string, SessionOptionValue>
): Record<string, SessionOptionValue> {
  if (record.agent !== 'claude' || typeof values.model !== 'string' || values.effort !== 'xhigh') {
    return values
  }
  const tracked = getTrackedSessionOption(record, values.model, 'effort')
  return tracked?.value === CLAUDE_ULTRACODE_EFFORT ? withoutEffort(values) : values
}
