import type { FileHandle } from 'node:fs/promises'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import {
  retainNativeChatTranscriptCompanion,
  type NativeChatTranscriptCompanion
} from '../../shared/fork-native-chat-session-options/native-chat-transcript-companion'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine,
  decodeOmpTranscriptLine
} from './transcript-line-decoders'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  nativeChatTranscriptCompanionDecoderForAgent,
  type NativeChatTranscriptCompanionDecoder
} from './fork-native-chat-session-options/transcript-companion-decoder'
import {
  findLastCompleteLineEnd,
  readTranscriptByteAt,
  TAIL_CHUNK_BYTES
} from './transcript-tail-boundary'
import {
  closeTranscriptHandle,
  wslGatedOpen,
  wslGatedRead,
  wslGatedStat
} from './wsl-transcript-fs-access'
import { wslTranscriptFsRefusal } from './wsl-transcript-fs-gate'

export const MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024

export type NativeChatLineDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export function nativeChatLineDecoderForAgent(agent: AgentType): NativeChatLineDecoder | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (transcriptAgent === 'claude') {
    return decodeClaudeTranscriptLine
  }
  if (transcriptAgent === 'codex') {
    return decodeCodexTranscriptLine
  }
  if (transcriptAgent === 'grok') {
    return decodeGrokTranscriptLine
  }
  if (transcriptAgent === 'omp') {
    return decodeOmpTranscriptLine
  }
  return null
}

export async function readNativeChatTranscriptTailFile(
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder,
  includeTrailingLine = false,
  endOffset?: number,
  decodeCompanion?: NativeChatTranscriptCompanionDecoder | null,
  signal?: AbortSignal
): Promise<{
  messages: NativeChatMessage[]
  companion?: NativeChatTranscriptCompanion
  consumedTo: number
  hasMore: boolean
  beforeOffset: number
  malformedRecordCount?: number
  oversizedRecordCount?: number
}> {
  signal?.throwIfAborted()
  const end = Math.min(
    (await wslGatedStat(filePath, 'exact', signal)).size,
    endOffset ?? Number.MAX_SAFE_INTEGER
  )
  signal?.throwIfAborted()
  if (end === 0) {
    return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
  }
  const handle = await wslGatedOpen(filePath, 'exact', signal)
  const lineParts: Buffer[] = []
  let lineBytes = 0
  let lineOversized = false
  let companion: NativeChatTranscriptCompanion | undefined
  let malformedRecordCount = 0
  let oversizedRecordCount = 0
  let ignoreNextMalformedRecord = false
  try {
    signal?.throwIfAborted()
    const consumedTo = includeTrailingLine
      ? end
      : await findLastCompleteLineEnd(handle, filePath, end, signal)
    if (consumedTo === 0) {
      return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
    }
    const newestFirst: { message: NativeChatMessage; offset: number }[] = []
    const finalByte = await readTranscriptByteAt(handle, filePath, consumedTo - 1, signal)
    if (finalByte === null) {
      // File shrank between stat and probe: report empty, the next poll re-stats.
      return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
    }
    ignoreNextMalformedRecord = finalByte !== 0x0a
    let cursor = consumedTo - (finalByte === 0x0a ? 1 : 0)
    while (cursor > 0 && newestFirst.length <= limit) {
      signal?.throwIfAborted()
      const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
      const buffer = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await wslGatedRead(
        handle,
        filePath,
        buffer,
        0,
        buffer.length,
        start,
        'exact',
        signal
      )
      signal?.throwIfAborted()
      // A short read means the file shrank mid-walk: stop paging back rather
      // than stitch non-adjacent bytes into records.
      if (bytesRead < buffer.length) {
        break
      }
      let segmentEnd = bytesRead
      for (let index = bytesRead - 1; index >= 0 && newestFirst.length <= limit; index--) {
        if (buffer[index] !== 0x0a) {
          continue
        }
        retainPart(buffer.subarray(index + 1, segmentEnd))
        if (!lineOversized) {
          decodeLine(start + index + 1, newestFirst)
        }
        resetLine()
        segmentEnd = index
      }
      if (segmentEnd > 0) {
        retainPart(buffer.subarray(0, segmentEnd))
      }
      cursor = start
    }
    if (cursor === 0 && lineParts.length > 0 && newestFirst.length <= limit) {
      decodeLine(0, newestFirst)
    }
    const chronological = newestFirst.toReversed()
    // Why: slice(-0) returns the whole array, so a non-positive limit must
    // window to nothing explicitly rather than leak every buffered record.
    const selected = limit > 0 ? chronological.slice(Math.max(0, chronological.length - limit)) : []
    return {
      messages: selected.map((entry) => entry.message),
      ...(companion ? { companion } : {}),
      consumedTo,
      hasMore: limit > 0 && chronological.length > limit,
      beforeOffset: selected[0]?.offset ?? end,
      ...(malformedRecordCount > 0 ? { malformedRecordCount } : {}),
      ...(oversizedRecordCount > 0 ? { oversizedRecordCount } : {})
    }
  } finally {
    await closeTranscriptHandle(handle, filePath)
  }

  function retainPart(part: Buffer): void {
    if (lineOversized) {
      return
    }
    lineBytes += part.length
    if (lineBytes > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
      lineParts.length = 0
      lineOversized = true
      oversizedRecordCount++
      return
    }
    lineParts.push(part)
  }

  function resetLine(): void {
    lineParts.length = 0
    lineBytes = 0
    lineOversized = false
  }

  function decodeLine(
    lineOffset: number,
    messages: { message: NativeChatMessage; offset: number }[]
  ): void {
    let line = Buffer.concat([...lineParts].toReversed()).toString('utf8')
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    if (!line) {
      return
    }
    try {
      JSON.parse(line)
    } catch {
      if (ignoreNextMalformedRecord) {
        ignoreNextMalformedRecord = false
        return
      }
      malformedRecordCount++
      return
    }
    ignoreNextMalformedRecord = false
    const fallbackId = transcriptFallbackId(filePath, lineOffset)
    // Why: scan the same bounded JSONL window for the provider-authored values
    // that ride alongside the messages — turn lifecycle, so reconnect snapshots
    // replay completion without guessing from the last assistant message, and
    // the recorded model/effort. Traversal is newest-first, so the first value
    // seen for a field is the newest and must not be rewound by an older row.
    companion = retainNativeChatTranscriptCompanion(companion, decodeCompanion?.(line, fallbackId))
    const message = decode(line, fallbackId)
    if (message) {
      messages.push({ message, offset: lineOffset })
    }
  }
}

export async function readNativeChatTranscriptTail(
  args: ResolveSessionFileOptions & {
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    filePath?: string
    limit: number
    beforeOffset?: number
  },
  signal?: AbortSignal
): Promise<
  | {
      messages: NativeChatMessage[]
      companion?: NativeChatTranscriptCompanion
      hasMore: boolean
      beforeOffset: number
    }
  | { error: string; notFound?: true }
> {
  const decode = nativeChatLineDecoderForAgent(args.agent)
  const decodeCompanion = nativeChatTranscriptCompanionDecoderForAgent(args.agent)
  if (!decode) {
    return { error: 'Transcript unavailable' }
  }
  let filePath: string | null
  try {
    filePath =
      args.filePath ?? (await resolveSessionFilePath(args.agent, args.sessionId, args, signal))
  } catch (error) {
    signal?.throwIfAborted()
    // Why: gate refusal is transient unavailability with retry guidance —
    // `notFound` would settle callers into a false "missing" state.
    return { error: wslTranscriptFsRefusal(error).message }
  }
  signal?.throwIfAborted()
  // Why: a new agent session can report its id before the first JSONL flush;
  // callers keep that miss in loading/retry rather than showing a false error.
  if (!filePath) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  try {
    const result = await readNativeChatTranscriptTailFile(
      filePath,
      args.limit,
      decode,
      true,
      args.beforeOffset,
      decodeCompanion,
      signal
    )
    signal?.throwIfAborted()
    return {
      messages: result.messages,
      // Why: an older pagination page must not rewind live state; only the
      // current transcript tail authoritatively describes the newest turn.
      ...(args.beforeOffset === undefined && result.companion
        ? { companion: result.companion }
        : {}),
      hasMore: result.hasMore,
      beforeOffset: result.beforeOffset
    }
  } catch (error) {
    signal?.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? { error: message, notFound: true }
      : { error: message }
  }
}
