import type { AgentType } from '../../../../../shared/agent-status-types'
import type {
  CatalogModel,
  CatalogOption
} from '../../../../../shared/agent-session-option-catalog'
import type { SessionOptionSelectChoice } from '../../../../../shared/native-chat-session-options'

/** Return the Claude PTY model list with Ultracode exposed only where xhigh exists. */
export function withUltracodeRung(
  agent: AgentType,
  models: readonly CatalogModel[]
): CatalogModel[] {
  if (agent !== 'claude') {
    return [...models]
  }
  return models.map((model) => {
    const options = model.options.map(withUltracodeEffortChoice)
    return options.some((option, index) => option !== model.options[index])
      ? { ...model, options }
      : model
  })
}

function withUltracodeEffortChoice(option: CatalogOption): CatalogOption {
  if (option.id !== 'effort' || option.kind.type !== 'select') {
    return option
  }
  const choices = withUltracodeChoices(option.kind.choices)
  if (choices === option.kind.choices) {
    return option
  }
  return {
    ...option,
    kind: {
      ...option.kind,
      choices
    }
  }
}

function withUltracodeChoices(choices: SessionOptionSelectChoice[]): SessionOptionSelectChoice[] {
  const hasXhigh = choices.some((choice) => choice.value === 'xhigh')
  const hasUltracode = choices.some((choice) => choice.value === 'ultracode')
  if (!hasXhigh || hasUltracode) {
    return choices
  }
  return [...choices, { value: 'ultracode', label: 'Ultracode' }]
}
