// Wire names for the native-chat relay surface, shared so the host and the
// relay cannot drift. Payloads travel as request/response; the only push is
// NATIVE_CHAT_CHANGED_METHOD, a seq-carrying ping that tells the host to pull.

export const NATIVE_CHAT_RELAY_READ_SESSION_METHOD = 'nativeChat.readSession'
export const NATIVE_CHAT_RELAY_SUBSCRIBE_METHOD = 'nativeChat.subscribe'
export const NATIVE_CHAT_RELAY_PULL_METHOD = 'nativeChat.pull'
export const NATIVE_CHAT_RELAY_UNSUBSCRIBE_METHOD = 'nativeChat.unsubscribe'
export const NATIVE_CHAT_CHANGED_METHOD = 'nativeChat.changed'

export const NATIVE_CHAT_RELAY_REQUEST_TIMEOUT_MS = 15_000

export type NativeChatRelayPing = { subscriptionId: string; seq: number }

export function parseNativeChatRelayPing(params: unknown): NativeChatRelayPing | null {
  if (!params || typeof params !== 'object') {
    return null
  }
  const record = params as Record<string, unknown>
  const subscriptionId = typeof record.subscriptionId === 'string' ? record.subscriptionId : ''
  const seq = typeof record.seq === 'number' && Number.isFinite(record.seq) ? record.seq : null
  return subscriptionId && seq !== null ? { subscriptionId, seq } : null
}
