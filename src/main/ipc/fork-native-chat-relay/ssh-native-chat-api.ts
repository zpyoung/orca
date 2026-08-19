import type { NativeChatRelayPing } from '../../../shared/fork-native-chat-relay/native-chat-relay-protocol'

type NativeChatRelaySession = {
  requestNativeChat: (
    method: string,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<unknown>
  onNativeChatChanged: (handler: (ping: NativeChatRelayPing) => void) => () => void
}

type ActiveSessions = { get: (targetId: string) => NativeChatRelaySession | undefined }

export async function requestActiveSshNativeChatFromSessions(
  activeSessions: ActiveSessions,
  targetId: string,
  method: string,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
  const session = activeSessions.get(targetId)
  if (!session) {
    throw new Error('SSH relay is not ready')
  }
  return session.requestNativeChat(method, params, options)
}

export function onActiveSshNativeChatChangedFromSessions(
  activeSessions: ActiveSessions,
  targetId: string,
  handler: (ping: NativeChatRelayPing) => void
): () => void {
  return activeSessions.get(targetId)?.onNativeChatChanged(handler) ?? (() => {})
}
