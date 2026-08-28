// FORK-COPY-OF: src/renderer/src/components/native-chat/native-chat-runtime-contract.ts
// FORK-COPY-SHA: 54076453b2725b39e07f07acd438d47b593d0d10
import type {
  NativeChatAppendedMessages,
  NativeChatReadSessionResult
} from '../../../../../preload/api-types'
import type {
  NativeChatSessionOptionObservation,
  NativeChatTurnLifecycle
} from '../../../../../shared/native-chat-types'
import type { NativeChatCompanionFrameFields } from '../../../../../shared/fork-native-chat-session-options/native-chat-transcript-companion'

export const RUNTIME_NATIVE_CHAT_READ_ERROR = "Couldn't read agent chat from the remote runtime."

export function parseRuntimeNativeChatTurnLifecycle(
  value: unknown
): NativeChatTurnLifecycle | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    (record.state !== 'working' &&
      record.state !== 'completed' &&
      record.state !== 'interrupted') ||
    typeof record.turnId !== 'string' ||
    record.turnId.trim().length === 0 ||
    (record.timestamp !== null &&
      record.timestamp !== undefined &&
      (typeof record.timestamp !== 'number' ||
        !Number.isFinite(record.timestamp) ||
        record.timestamp <= 0))
  ) {
    return undefined
  }
  return {
    state: record.state,
    turnId: record.turnId.trim(),
    // Why: an omitted timestamp is a valid payload; normalize it to null rather
    // than dropping the whole lifecycle record.
    timestamp: record.timestamp ?? null
  }
}

/** A remote runtime old enough to omit this simply reports nothing observed —
 *  the composer keeps its terminal-scrape fallback, so absence is not an error. */
export function parseRuntimeNativeChatSessionOptions(
  value: unknown
): NativeChatSessionOptionObservation | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  const effort = typeof record.effort === 'string' ? record.effort.trim() : ''
  if (!model && !effort) {
    return undefined
  }
  const observedAt =
    typeof record.observedAt === 'number' && Number.isFinite(record.observedAt)
      ? record.observedAt
      : null
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    observedAt
  }
}

/** The two companion keys off one frame, validated. Every hop spreads this so a
 *  frame can never carry one of them through a path that forgot the other. */
export function parseRuntimeNativeChatCompanionFields(
  frame: { lifecycle?: unknown; sessionOptions?: unknown } | null | undefined
): NativeChatCompanionFrameFields {
  const lifecycle = parseRuntimeNativeChatTurnLifecycle(frame?.lifecycle)
  const sessionOptions = parseRuntimeNativeChatSessionOptions(frame?.sessionOptions)
  return {
    ...(lifecycle ? { lifecycle } : {}),
    ...(sessionOptions ? { sessionOptions } : {})
  }
}

export function parseRuntimeNativeChatReadSessionResult(
  value: unknown
): NativeChatReadSessionResult {
  if (typeof value !== 'object' || value === null) {
    return { error: RUNTIME_NATIVE_CHAT_READ_ERROR }
  }
  const record = value as Record<string, unknown>
  if (Array.isArray(record.messages)) {
    return {
      messages: record.messages as NativeChatAppendedMessages,
      ...parseRuntimeNativeChatCompanionFields(record),
      // Dropping these would leave the caller inferring "older history exists"
      // from the returned count and unable to page past the first window.
      ...(typeof record.hasMore === 'boolean' ? { hasMore: record.hasMore } : {}),
      ...(typeof record.beforeOffset === 'number' && Number.isFinite(record.beforeOffset)
        ? { beforeOffset: record.beforeOffset }
        : {})
    }
  }
  if (typeof record.error === 'string') {
    return {
      error: record.error,
      ...(record.notFound === true ? { notFound: true } : {})
    }
  }
  return { error: RUNTIME_NATIVE_CHAT_READ_ERROR }
}
