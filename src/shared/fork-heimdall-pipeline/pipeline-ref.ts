import { NodeIdSchema, type NodeId } from './node-id'

export type PipelineNamedRef = { scope: 'builtin' | 'repo' | 'user'; id: NodeId }
export type PipelinePathRef = { scope: 'path'; path: string }
export type PipelineRef = PipelineNamedRef | PipelinePathRef
export type PipelineRefParseResult = PipelineRef | { error: string }

function errorResult(message: string): PipelineRefParseResult {
  return { error: message }
}

function namedRef(scope: PipelineNamedRef['scope'], id: string): PipelineRefParseResult {
  const parsedId = NodeIdSchema.safeParse(id)
  return parsedId.success ? { scope, id: parsedId.data } : errorResult('Pipeline id is invalid')
}

export function parsePipelineRef(text: string): PipelineRefParseResult {
  if (text.length === 0 || text.length > 300 || text !== text.trim()) {
    return errorResult('Pipeline reference must be a non-empty bounded string')
  }
  if (text.startsWith('builtin:')) {
    return namedRef('builtin', text.slice('builtin:'.length))
  }
  if (text.startsWith('user:')) {
    return namedRef('user', text.slice('user:'.length))
  }
  const pathMatch = /^(?:\.orca\/pipelines\/|pipelines\/)([a-z][a-z0-9-]{0,62})\.yaml$/u.exec(text)
  if (pathMatch !== null) {
    return { scope: 'path', path: text }
  }
  if (text.startsWith('.orca/pipelines/') || text.startsWith('pipelines/')) {
    return errorResult('Pipeline path must be an exact pipeline YAML file')
  }
  if (text.includes('/') || text.includes('\\')) {
    return errorResult('Pipeline path is not a supported pipeline location')
  }
  return namedRef('repo', text)
}
