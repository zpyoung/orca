import type { PipelineDocument } from '../../shared/fork-heimdall-pipeline/document-schema'
import { PipelineInputNameSchema } from '../../shared/fork-heimdall-pipeline/document-schema'
import { getRepeatedStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

export type PipelineRunInputValue = string | number | boolean

function parseInputValue(
  name: string,
  value: string,
  type: 'text' | 'number' | 'boolean'
): PipelineRunInputValue {
  if (type === 'text') {
    return value
  }
  if (type === 'number') {
    const parsed = Number(value)
    if (value.trim().length === 0 || !Number.isFinite(parsed)) {
      throw new RuntimeClientError('invalid_argument', `--input ${name} must be a finite number.`)
    }
    return parsed
  }
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  throw new RuntimeClientError('invalid_argument', `--input ${name} must be true or false.`)
}

export function buildPipelineRunInputs(
  flags: Map<string, string | boolean>,
  document: PipelineDocument
): Record<string, PipelineRunInputValue> {
  const task = getRequiredStringFlag(flags, 'spec')
  if (task.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', '--spec must contain task text.')
  }
  const taskDefinition = document.inputs.task
  if (taskDefinition !== undefined && taskDefinition.type !== 'text') {
    throw new RuntimeClientError('invalid_argument', 'The pipeline task input must have type text.')
  }

  const inputs: Record<string, PipelineRunInputValue> = {}
  for (const [name, definition] of Object.entries(document.inputs)) {
    if (definition.default !== undefined) {
      inputs[name] = definition.default
    }
  }
  inputs.task = task

  for (const assignment of getRepeatedStringFlag(flags, 'input')) {
    const separator = assignment.indexOf('=')
    if (separator <= 0 || separator === assignment.length - 1) {
      throw new RuntimeClientError('invalid_argument', '--input must be <name>=<value>.')
    }
    const name = assignment.slice(0, separator)
    if (!PipelineInputNameSchema.safeParse(name).success) {
      throw new RuntimeClientError('invalid_argument', `--input name "${name}" is invalid.`)
    }
    if (name === 'task') {
      throw new RuntimeClientError('invalid_argument', 'Use --spec to set the task input.')
    }
    const definition = document.inputs[name]
    if (definition === undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Pipeline ${document.id} has no input named "${name}".`
      )
    }
    inputs[name] = parseInputValue(name, assignment.slice(separator + 1), definition.type)
  }

  for (const [name, definition] of Object.entries(document.inputs)) {
    if (definition.required && inputs[name] === undefined) {
      throw new RuntimeClientError('invalid_argument', `Pipeline input "${name}" is required.`)
    }
  }
  return inputs
}
