import { sha256 } from '../sha256'
import { measureUtf8ByteLength } from '../utf8-byte-limits'

export const SCRIPT_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,62}$/u
export const SCRIPT_ENV_VALUE_MAX_BYTES = 16 * 1024
export const SCRIPT_ENV_TOTAL_MAX_BYTES = 64 * 1024

const DENIED_SCRIPT_ENV_NAMES: Readonly<Record<string, true>> = {
  PATH: true,
  HOME: true,
  SHELL: true,
  IFS: true,
  ENV: true,
  BASH_ENV: true,
  PS4: true
}

export function isDeniedScriptEnvName(name: string): boolean {
  return (
    DENIED_SCRIPT_ENV_NAMES[name] === true ||
    name.startsWith('LD_') ||
    name.startsWith('DYLD_') ||
    name.startsWith('ORCA_')
  )
}

export class ScriptEnvTooLargeError extends Error {
  constructor() {
    super('Script environment exceeds its byte limit')
    this.name = 'ScriptEnvTooLargeError'
  }
}

function sortedEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  const sorted: Record<string, string> = {}
  let totalBytes = 0
  for (const name of Object.keys(env).sort()) {
    const value = env[name]
    if (value === undefined) {
      continue
    }
    const nameBytes = measureUtf8ByteLength(name).byteLength
    const valueBytes = measureUtf8ByteLength(value).byteLength
    if (valueBytes > SCRIPT_ENV_VALUE_MAX_BYTES) {
      throw new ScriptEnvTooLargeError()
    }
    totalBytes += nameBytes + valueBytes + 2
    if (totalBytes > SCRIPT_ENV_TOTAL_MAX_BYTES) {
      throw new ScriptEnvTooLargeError()
    }
    sorted[name] = value
  }
  return sorted
}

function toHex(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0')
  }
  return result
}

export function scriptApprovalDigest(input: {
  command: string
  env: Readonly<Record<string, string>>
}): `sha256:${string}` {
  const canonical = JSON.stringify({ command: input.command, env: sortedEnvironment(input.env) })
  return `sha256:${toHex(sha256(new TextEncoder().encode(canonical)))}`
}

export function describeScriptApproval(input: {
  command: string
  env: Readonly<Record<string, string>>
}): string {
  const lines = [input.command]
  for (const name of Object.keys(input.env).sort()) {
    const value = input.env[name]
    if (value !== undefined) {
      lines.push(`${name}=${value.length > 200 ? `${value.slice(0, 200)}…` : value}`)
    }
  }
  return lines.join('\n')
}
