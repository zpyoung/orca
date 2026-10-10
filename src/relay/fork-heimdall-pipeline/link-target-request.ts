import { readlink } from 'node:fs/promises'
import { expandTilde } from '../context'

export async function readRelayLinkTarget(params: unknown): Promise<string> {
  if (
    typeof params !== 'object' ||
    params === null ||
    Array.isArray(params) ||
    !('filePath' in params) ||
    typeof params.filePath !== 'string' ||
    params.filePath.length === 0
  ) {
    throw new Error('fs.readlink requires a filePath')
  }
  return readlink(expandTilde(params.filePath))
}
