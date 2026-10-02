import { sha256 } from '../sha256'
import type { PipelineDocument } from './document-schema'

function canonicalJsonValue(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJsonValue(child)}`)
    return `{${entries.join(',')}}`
  }
  const serialized = JSON.stringify(value)
  return serialized ?? 'null'
}

function toHex(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0')
  }
  return result
}

export function canonicalPipelineJson(document: PipelineDocument): string {
  return canonicalJsonValue(document)
}

export function pipelineContentHash(document: PipelineDocument): `sha256:${string}` {
  const bytes = new TextEncoder().encode(canonicalPipelineJson(document))
  return `sha256:${toHex(sha256(bytes))}`
}
