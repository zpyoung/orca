import { measureUtf8ByteLength } from '../utf8-byte-limits'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../orchestration-worker-start-prompt-budget'
import type { PipelineOutputType } from './document-schema'

export type PipelineOutputReference =
  | { kind: 'output'; nodeId: string; name: string; start: number; end: number }
  | { kind: 'input'; name: string; start: number; end: number }
  | { kind: 'task'; field: 'id' | 'title' | 'spec'; start: number; end: number }

export type PipelineOutputValue = { type: PipelineOutputType; value: unknown }
export type PipelineTaskReferenceValues = { id: string; title: string; spec: string }
export type RenderPromptInput = {
  prompt: string
  outputs?: Readonly<Record<string, Readonly<Record<string, PipelineOutputValue>>>>
  runInputs?: Readonly<Record<string, string | number | boolean>>
  task?: PipelineTaskReferenceValues
  workspacePath: string
  retryContext?: string
  reviewerObjections?: string | readonly string[]
  sendBackComment?: string
  reportInstructions?: string
}
export type RenderPromptResult =
  | { ok: true; text: string }
  | { ok: false; failureClass: 'criteria' }

const OUTPUT_REF_PATTERN =
  /\$(run\.inputs\.[a-zA-Z][a-zA-Z0-9_]{0,62}|[a-z][a-z0-9-]{0,62}\.outputs\.[a-zA-Z][a-zA-Z0-9_]{0,62}|task\.(?:id|title|spec))/gu

export function findOutputRefs(text: string): PipelineOutputReference[] {
  const references: PipelineOutputReference[] = []
  const pattern = new RegExp(OUTPUT_REF_PATTERN.source, OUTPUT_REF_PATTERN.flags)
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const expression = match[1]
    if (expression === undefined) {
      continue
    }
    const start = match.index
    const end = start + match[0].length
    if (expression.startsWith('run.inputs.')) {
      references.push({ kind: 'input', name: expression.slice('run.inputs.'.length), start, end })
    } else if (expression.startsWith('task.')) {
      const field = expression.slice('task.'.length)
      if (field === 'id' || field === 'title' || field === 'spec') {
        references.push({ kind: 'task', field, start, end })
      }
    } else {
      const separator = expression.indexOf('.outputs.')
      references.push({
        kind: 'output',
        nodeId: expression.slice(0, separator),
        name: expression.slice(separator + '.outputs.'.length),
        start,
        end
      })
    }
  }
  return references
}

function fileOutputPath(workspacePath: string, relativePath: string): string {
  const drive = /^[A-Za-z]:/u.exec(workspacePath)?.[0] ?? ''
  const uncRoot = workspacePath.startsWith('\\\\') || workspacePath.startsWith('//')
  const windowsPath = drive.length > 0 || uncRoot || workspacePath.includes('\\')
  const separator = windowsPath ? '\\' : '/'
  const rooted =
    uncRoot ||
    (drive.length > 0 && /^[\\/]/u.test(workspacePath.slice(2))) ||
    (!windowsPath && workspacePath.startsWith('/')) ||
    (windowsPath && drive.length === 0 && workspacePath.startsWith('\\'))
  const rootPrefix = uncRoot
    ? '\\\\'
    : drive.length > 0
      ? `${drive}${rooted ? separator : ''}`
      : rooted
        ? separator
        : ''
  const pathBase = uncRoot
    ? workspacePath.slice(2)
    : drive.length > 0
      ? workspacePath.slice(2).replace(/^[\\/]+/u, '')
      : rooted
        ? workspacePath.replace(/^[\\/]+/u, '')
        : workspacePath
  const combinedPath = [pathBase, relativePath].filter((part) => part.length > 0).join(separator)
  const pathSeparator = windowsPath ? /[\\/]+/u : /\/+/u
  const segments: string[] = []
  for (const segment of combinedPath.split(pathSeparator)) {
    if (segment.length === 0 || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!rooted) {
        segments.push(segment)
      }
    } else {
      segments.push(segment)
    }
  }
  const normalizedPath = segments.join(separator)
  if (rootPrefix.length === 0 || normalizedPath.length === 0) {
    return `${rootPrefix}${normalizedPath}`
  }
  return rootPrefix.endsWith(separator)
    ? `${rootPrefix}${normalizedPath}`
    : `${rootPrefix}${separator}${normalizedPath}`
}

function renderOutput(value: PipelineOutputValue, workspacePath: string): string {
  switch (value.type.type) {
    case 'text':
    case 'enum':
      return typeof value.value === 'string' ? value.value : String(value.value ?? '')
    case 'number':
    case 'boolean':
      return String(value.value)
    case 'json':
    case 'taskList':
    case 'verdict':
      return `\`\`\`json\n${JSON.stringify(value.value, null, 2)}\n\`\`\``
    case 'file':
      return fileOutputPath(workspacePath, String(value.value))
  }
}

function resolveReference(reference: PipelineOutputReference, input: RenderPromptInput): string {
  if (reference.kind === 'input') {
    return String(input.runInputs?.[reference.name] ?? '')
  }
  if (reference.kind === 'task') {
    return input.task?.[reference.field] ?? ''
  }
  const value = input.outputs?.[reference.nodeId]?.[reference.name]
  return value === undefined ? '' : renderOutput(value, input.workspacePath)
}

function appendPromptSections(input: RenderPromptInput): string {
  const objections =
    typeof input.reviewerObjections === 'string'
      ? input.reviewerObjections
      : input.reviewerObjections?.join('\n')
  const sections: [string, string | undefined][] = [
    ['Retry context', input.retryContext],
    ['Reviewer objections', objections],
    ['Send-back comment', input.sendBackComment],
    ['Report instructions', input.reportInstructions]
  ]
  let result = input.prompt
  for (const [heading, content] of sections) {
    if (content !== undefined && content.length > 0) {
      result += `${result.length > 0 ? '\n\n' : ''}## ${heading}\n${content}`
    }
  }
  return result
}

export function renderPrompt(input: RenderPromptInput): RenderPromptResult {
  let rendered = ''
  let offset = 0
  for (const reference of findOutputRefs(input.prompt)) {
    rendered += input.prompt.slice(offset, reference.start)
    rendered += resolveReference(reference, input)
    offset = reference.end
  }
  rendered += input.prompt.slice(offset)
  const text = appendPromptSections({ ...input, prompt: rendered })
  return measureUtf8ByteLength(text, {
    stopAfterBytes: ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES
  }).exceededLimit
    ? { ok: false, failureClass: 'criteria' }
    : { ok: true, text }
}
