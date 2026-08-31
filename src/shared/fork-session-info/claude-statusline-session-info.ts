import {
  parseClaudeStatusLineBody as parseRateLimits,
  type ClaudeStatusLineRateLimits
} from '../claude-statusline-rate-limits'
import type {
  SessionInfoContextTelemetry,
  SessionInfoFilesTelemetry,
  SessionInfoIdentityTelemetry,
  SessionInfoPaneTelemetry
} from './session-info-types'

const MAX_ID_LENGTH = 512
const MAX_PATH_LENGTH = 32_768

export type ClaudeSessionInfoStatusLineEvent = ClaudeStatusLineRateLimits & {
  paneKey?: string
  telemetry?: SessionInfoPaneTelemetry
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) {
    return undefined
  }
  for (const character of trimmed) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) {
      return undefined
    }
  }
  return trimmed
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function percentage(value: unknown): number | undefined {
  const parsed = nonnegativeNumber(value)
  return parsed !== undefined && parsed <= 100 ? parsed : undefined
}

function buildIdentity(
  payload: Record<string, unknown>,
  updatedAt: number
): SessionInfoIdentityTelemetry | undefined {
  const model = record(payload.model)
  const outputStyle = record(payload.output_style)
  const identity: SessionInfoIdentityTelemetry = {
    sessionId: boundedString(payload.session_id, MAX_ID_LENGTH),
    transcriptPath: boundedString(payload.transcript_path, MAX_PATH_LENGTH),
    cwd: boundedString(payload.cwd, MAX_PATH_LENGTH),
    modelId: boundedString(model?.id, MAX_ID_LENGTH),
    modelDisplayName: boundedString(model?.display_name, MAX_ID_LENGTH),
    agentVersion: boundedString(payload.version, MAX_ID_LENGTH),
    outputStyle: boundedString(outputStyle?.name, MAX_ID_LENGTH),
    updatedAt
  }
  return Object.keys(identity).length > 1 ? identity : undefined
}

function buildContext(
  payload: Record<string, unknown>,
  updatedAt: number
): SessionInfoContextTelemetry | undefined {
  const context = record(payload.context_window)
  if (!context) {
    return undefined
  }
  const usedPercentage = percentage(context.used_percentage)
  if (usedPercentage === undefined) {
    return undefined
  }
  const remainingPercentage = percentage(context.remaining_percentage)
  const windowSize = nonnegativeNumber(context.context_window_size)
  return {
    usedPercentage,
    ...(remainingPercentage !== undefined ? { remainingPercentage } : {}),
    ...(windowSize !== undefined && windowSize > 0 ? { windowSize } : {}),
    updatedAt
  }
}

function buildFiles(
  payload: Record<string, unknown>,
  updatedAt: number
): SessionInfoFilesTelemetry | undefined {
  const cost = record(payload.cost)
  if (!cost) {
    return undefined
  }
  const linesAdded = nonnegativeNumber(cost.total_lines_added)
  const linesRemoved = nonnegativeNumber(cost.total_lines_removed)
  if (linesAdded === undefined && linesRemoved === undefined) {
    return undefined
  }
  return {
    ...(linesAdded !== undefined ? { linesAdded } : {}),
    ...(linesRemoved !== undefined ? { linesRemoved } : {}),
    updatedAt
  }
}

/** Parse the pane-scoped Claude statusline projection without retaining the raw payload. */
export function parseClaudeSessionInfoStatusLineBody(
  body: unknown,
  updatedAt = Date.now()
): ClaudeSessionInfoStatusLineEvent | null {
  const rateLimits = parseRateLimits(body)
  const fields = record(body)
  const paneKey = boundedString(fields?.paneKey, MAX_ID_LENGTH)
  const payloadText = typeof fields?.payload === 'string' ? fields.payload : ''
  let payload: Record<string, unknown> | null = null
  try {
    payload = record(JSON.parse(payloadText))
  } catch {
    payload = null
  }
  const identity = payload ? buildIdentity(payload, updatedAt) : undefined
  const context = payload ? buildContext(payload, updatedAt) : undefined
  const filesTouched = payload ? buildFiles(payload, updatedAt) : undefined
  const providerSessionId = identity?.sessionId
  const telemetry =
    paneKey && providerSessionId && (identity || context || filesTouched)
      ? {
          paneKey,
          provider: 'claude',
          providerSessionId,
          ...(identity ? { identity } : {}),
          ...(context ? { context } : {}),
          ...(filesTouched ? { filesTouched } : {}),
          updatedAt
        }
      : undefined
  if (!rateLimits && !telemetry) {
    return null
  }
  return {
    configDir: rateLimits?.configDir ?? boundedString(fields?.configDir, MAX_PATH_LENGTH) ?? null,
    fiveHour: rateLimits?.fiveHour ?? null,
    sevenDay: rateLimits?.sevenDay ?? null,
    ...(paneKey ? { paneKey } : {}),
    ...(telemetry ? { telemetry } : {})
  }
}
