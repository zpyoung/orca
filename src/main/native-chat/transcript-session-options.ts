// Per-line decoders for the model/effort an agent records about itself.
//
// Stateless, like the message decoders in transcript-line-decoders.ts: the full
// reader and the live tailer both call these and must agree, so nothing here may
// carry state between lines. A record that names neither value returns null.

import type { AgentType, NativeChatSessionOptionObservation } from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import {
  asRecord,
  extractModel,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'

export type NativeChatSessionOptionDecoder = (
  line: string
) => NativeChatSessionOptionObservation | null

// Claude's placeholder on rows it generated without calling a model; it names no
// real selection, so a row carrying it is not evidence of anything.
const CLAUDE_SYNTHETIC_MODEL = '<synthetic>'

export function nativeChatSessionOptionDecoderForAgent(
  agent: AgentType
): NativeChatSessionOptionDecoder | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (transcriptAgent === 'claude') {
    return decodeClaudeSessionOptions
  }
  if (transcriptAgent === 'codex') {
    return decodeCodexSessionOptions
  }
  // grok and omp: no sampled record shape to decode against. Returning null keeps
  // their pickers on the scrape path rather than inventing a field name.
  return null
}

/** Claude stamps every assistant row with the model that answered it and the
 *  effort it ran at — `effort` on the row, `model` inside `message`. */
export function decodeClaudeSessionOptions(
  line: string
): NativeChatSessionOptionObservation | null {
  const record = parseJsonObject(line)
  if (record?.type !== 'assistant') {
    return null
  }
  const model = extractModel(asRecord(record.message))
  return buildObservation({
    model: model === CLAUDE_SYNTHETIC_MODEL ? null : model,
    effort: extractString(record.effort),
    timestamp: record.timestamp
  })
}

/** Codex opens each turn with a `turn_context` row naming the model and effort
 *  that turn will use. It decodes to no message, so only this path sees it. */
export function decodeCodexSessionOptions(line: string): NativeChatSessionOptionObservation | null {
  const record = parseJsonObject(line)
  const payload = asRecord(record?.payload)
  if (record?.type !== 'turn_context' || !payload) {
    return null
  }
  return buildObservation({
    model: extractModel(payload),
    effort: extractString(payload.effort),
    timestamp: record.timestamp
  })
}

function buildObservation(args: {
  model: string | null
  effort: string | null
  timestamp: unknown
}): NativeChatSessionOptionObservation | null {
  if (!args.model && !args.effort) {
    return null
  }
  const parsed = timestampMs(args.timestamp)
  return {
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    observedAt: Number.isFinite(parsed) ? parsed : null
  }
}
