import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import { parseClaudeUsageFile } from '../claude-usage/transcript-record-parser'
import type {
  SessionInfoContextTelemetry,
  SessionInfoUsageTelemetry
} from '../../shared/fork-session-info/session-info-types'

const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000

type ClaudeAssistantRecord = {
  type?: string
  sessionId?: string
  isSidechain?: boolean
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

async function readTranscriptContextFallback(
  transcriptPath: string,
  providerSessionId: string,
  updatedAt: number
): Promise<SessionInfoContextTelemetry | undefined> {
  const fallbackSessionId = basename(transcriptPath, '.jsonl')
  let currentTokens: number | undefined
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  for await (const line of lines) {
    let record: ClaudeAssistantRecord
    try {
      record = JSON.parse(line) as ClaudeAssistantRecord
    } catch {
      continue
    }
    if (
      record.type !== 'assistant' ||
      record.isSidechain === true ||
      (record.sessionId ?? fallbackSessionId) !== providerSessionId
    ) {
      continue
    }
    const usage = record.message?.usage
    const nextTokens =
      tokenCount(usage?.input_tokens) +
      tokenCount(usage?.output_tokens) +
      tokenCount(usage?.cache_read_input_tokens) +
      tokenCount(usage?.cache_creation_input_tokens)
    if (nextTokens > 0) {
      currentTokens = nextTokens
    }
  }
  if (currentTokens === undefined) {
    return undefined
  }
  const usedPercentage = Math.min(100, (currentTokens / DEFAULT_CLAUDE_CONTEXT_WINDOW) * 100)
  return {
    usedPercentage,
    remainingPercentage: 100 - usedPercentage,
    windowSize: DEFAULT_CLAUDE_CONTEXT_WINDOW,
    updatedAt
  }
}

/** Read one hook-authoritative Claude transcript and summarize the current provider session. */
export async function readClaudeSessionUsage(
  transcriptPath: string,
  providerSessionId: string,
  updatedAt = Date.now()
): Promise<SessionInfoUsageTelemetry> {
  const turns = (await parseClaudeUsageFile(transcriptPath)).filter(
    (turn) => turn.sessionId === providerSessionId
  )
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let model: string | undefined
  let cwd: string | undefined
  let branch: string | undefined
  for (const turn of turns) {
    inputTokens += turn.inputTokens
    outputTokens += turn.outputTokens
    cacheReadTokens += turn.cacheReadTokens
    cacheWriteTokens += turn.cacheWriteTokens
    model = turn.model ?? model
    cwd = turn.cwd ?? cwd
    branch = turn.gitBranch ?? branch
  }
  const contextFallback = await readTranscriptContextFallback(
    transcriptPath,
    providerSessionId,
    updatedAt
  )
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    turnCount: turns.length,
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(branch ? { branch } : {}),
    ...(contextFallback ? { contextFallback } : {}),
    freshness: 'ready',
    updatedAt
  }
}
