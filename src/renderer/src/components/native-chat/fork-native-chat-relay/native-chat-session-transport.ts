// FORK-COPY-OF: src/renderer/src/components/native-chat/native-chat-session-transport.ts
// FORK-COPY-SHA: 965978bc78bf03a6a43187c1ed28fcffe0e01bb5
import type {
  NativeChatApi,
  NativeChatAppendedMessages,
  NativeChatReadSessionArgs,
  NativeChatReadSessionResult
} from '../../../../../preload/api-types'
import { isWebClientLocation } from '@/lib/web-client-location'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  parseRuntimeNativeChatReadSessionResult,
  parseRuntimeNativeChatCompanionFields,
  runtimeNativeChatReadError
} from './native-chat-runtime-contract'
import { translate } from '@/i18n/i18n'

/** The read/subscribe surface the live-session hook needs, decoupled from where
 *  the transcript actually lives. Same shape as `window.api.nativeChat`, so the
 *  hook and everything downstream (merge, assembler, pagination) are unchanged. */
export type NativeChatSessionTransport = {
  readSession: (args: NativeChatReadSessionArgs) => Promise<NativeChatReadSessionResult>
  subscribe: NativeChatApi['subscribe']
}

function runtimeTooOldMessage(): string {
  return translate(
    'components.native-chat.runtime.tooOld',
    'This remote runtime is too old to show agent chat history. Update the remote runtime to view it.'
  )
}

export const RUNTIME_NATIVE_CHAT_RECONNECT_MS = 2_000

/** Label only method/version blocks as update requirements; transient failures need generic copy (KTD-4). */
export function toRuntimeNativeChatErrorMessage(err: unknown): string {
  if (err instanceof RuntimeRpcCallError && err.code === 'method_not_found') {
    return runtimeTooOldMessage()
  }
  if (isRuntimeCompatBlockError(err)) {
    return runtimeTooOldMessage()
  }
  return runtimeNativeChatReadError()
}

/** The web preload bridge answers `subscribe` with a Promise instead of the
 *  desktop's sync unsubscribe fn; calling that as a function crashed the view (R6). */
function toSyncUnsubscribe(handle: unknown): () => void {
  return () => {
    if (typeof handle === 'function') {
      ;(handle as () => void)()
      return
    }
    if (handle && typeof (handle as { then?: unknown }).then === 'function') {
      void (handle as Promise<unknown>).then((resolved) => {
        if (typeof resolved === 'function') {
          ;(resolved as () => void)()
        }
      })
    }
  }
}

function readLocalNativeChatSession(
  args: NativeChatReadSessionArgs
): Promise<NativeChatReadSessionResult> {
  // the positional public type keeps upstream consumers unchanged; the bridge also accepts object reads
  const readSession = window.api.nativeChat.readSession as unknown as (
    args: NativeChatReadSessionArgs
  ) => Promise<NativeChatReadSessionResult>
  return readSession(args)
}

/** Delegates straight to the local Electron IPC bridge. On the web client
 *  `window.api.nativeChat` already bridges to the paired runtime, so web keeps
 *  using this adapter (R3). */
const localNativeChatTransport: NativeChatSessionTransport = {
  readSession: readLocalNativeChatSession,
  subscribe: (args, onFrame) => toSyncUnsubscribe(window.api.nativeChat.subscribe(args, onFrame))
}

function createRuntimeNativeChatTransport(environmentId: string): NativeChatSessionTransport {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId }

  return {
    readSession: async ({ agent, sessionId, limit, transcriptPath, beforeOffset }) => {
      try {
        const result = await callRuntimeRpc<unknown>(
          target,
          'nativeChat.readSession',
          {
            agent,
            sessionId,
            limit,
            transcriptPath,
            beforeOffset,
            capabilities: { transcriptSourceOrder: 1 }
          },
          { timeoutMs: 15_000 }
        )
        return parseRuntimeNativeChatReadSessionResult(result)
      } catch (err) {
        return { error: toRuntimeNativeChatErrorMessage(err) }
      }
    },
    subscribe: (args, onFrame) => {
      const { subscriptionId, agent, sessionId, transcriptPath, limit } = args
      let cancelled = false
      let receivedInitial = false
      let handleUnsubscribe: (() => void) | null = null
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null
      let activeAttempt = 0
      let reconnectPendingAttempt: number | null = null

      // Reconnect established streams after drops; merge replay by id. Initial failures surface once instead of retrying.
      const scheduleReconnect = (attempt: number): void => {
        if (attempt !== activeAttempt) {
          return
        }
        handleUnsubscribe = null
        reconnectPendingAttempt = attempt
        if (cancelled || reconnectTimer) {
          return
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          reconnectPendingAttempt = null
          if (!cancelled) {
            openStream()
          }
        }, RUNTIME_NATIVE_CHAT_RECONNECT_MS)
      }

      const openStream = (): void => {
        const attempt = ++activeAttempt
        void window.api.runtimeEnvironments
          .subscribe(
            {
              selector: environmentId,
              method: 'nativeChat.subscribe',
              params: {
                subscriptionId,
                agent,
                sessionId,
                transcriptPath,
                limit,
                capabilities: { transcriptPending: 1, transcriptSourceOrder: 1 }
              },
              timeoutMs: 15_000
            },
            {
              onResponse: (response) => {
                if (cancelled || attempt !== activeAttempt) {
                  return
                }
                if (response.ok === false) {
                  if (!receivedInitial) {
                    receivedInitial = true
                    onFrame({
                      type: 'snapshot',
                      messages: [],
                      hasMore: false,
                      error: toRuntimeNativeChatErrorMessage(new RuntimeRpcCallError(response))
                    })
                  } else {
                    handleUnsubscribe?.()
                    scheduleReconnect(attempt)
                  }
                  return
                }
                const frame = response.result as {
                  type?: string
                  messages?: NativeChatAppendedMessages
                  hasMore?: boolean
                  beforeOffset?: number
                  error?: string
                  lifecycle?: unknown
                  sessionOptions?: unknown
                  pending?: boolean
                }
                const companion = parseRuntimeNativeChatCompanionFields(frame)
                // No transcript behind this window yet — forwarded so the view can
                // stop spinning, but it is not the settled initial read.
                const pending = frame?.pending === true
                // Seeds the paging cursor: a snapshot supersedes the seed read
                // that carried the offset, so dropping it here retires paging.
                const offset =
                  typeof frame?.beforeOffset === 'number' && Number.isFinite(frame.beforeOffset)
                    ? { beforeOffset: frame.beforeOffset }
                    : {}
                if (
                  (frame?.type === 'appended' ||
                    frame?.type === 'snapshot' ||
                    frame?.type === 'replacement') &&
                  Array.isArray(frame.messages)
                ) {
                  if (!receivedInitial) {
                    if (!pending) {
                      receivedInitial = true
                    }
                    onFrame({
                      type: 'snapshot',
                      messages: frame.messages,
                      hasMore: frame.hasMore ?? frame.messages.length >= (limit ?? 300),
                      ...offset,
                      ...(frame.error ? { error: frame.error } : {}),
                      ...companion,
                      ...(pending ? { pending: true } : {})
                    })
                  } else if (frame.type === 'snapshot') {
                    onFrame({
                      type: 'snapshot',
                      messages: frame.messages,
                      hasMore: frame.hasMore ?? false,
                      ...offset,
                      ...(frame.error ? { error: frame.error } : {}),
                      ...companion,
                      ...(pending ? { pending: true } : {})
                    })
                  } else {
                    onFrame(
                      frame.type === 'replacement'
                        ? {
                            type: 'replacement',
                            messages: frame.messages,
                            hasMore: frame.hasMore ?? false,
                            ...offset,
                            ...companion
                          }
                        : {
                            type: 'appended',
                            messages: frame.messages,
                            ...companion
                          }
                    )
                  }
                } else if (!receivedInitial) {
                  // Settle unrecognized successful payloads with an empty snapshot/error so loading cannot remain stuck.
                  receivedInitial = true
                  onFrame({
                    type: 'snapshot',
                    messages: [],
                    hasMore: false,
                    ...(frame?.error ? { error: frame.error } : {})
                  })
                }
              },
              // Teardown also closes the stream; cancelled prevents its reconnect.
              onError: () => scheduleReconnect(attempt),
              onClose: () => scheduleReconnect(attempt)
            }
          )
          .then((handle) => {
            // Stale reconnect handles must never replace or tear down the current stream.
            if (cancelled || attempt !== activeAttempt || reconnectPendingAttempt === attempt) {
              handle.unsubscribe()
              return
            }
            handleUnsubscribe = handle.unsubscribe
          })
          .catch((err: unknown) => {
            if (cancelled || attempt !== activeAttempt) {
              return
            }
            // Initial failures use the direct-read compatibility message.
            if (!receivedInitial) {
              receivedInitial = true
              onFrame({
                type: 'snapshot',
                messages: [],
                hasMore: false,
                error: toRuntimeNativeChatErrorMessage(err)
              })
              return
            }
            // Failed reconnects remain transient; retain backoff retries for live views.
            scheduleReconnect(attempt)
          })
      }

      openStream()

      // Socket closure reaps its watcher; an unsubscribe RPC would use the wrong connection cleanup key.
      return () => {
        cancelled = true
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        reconnectPendingAttempt = null
        handleUnsubscribe?.()
        handleUnsubscribe = null
      }
    }
  }
}

/** Select the read/subscribe transport for a pane. Route to the remote runtime
 *  only for a `runtime:`-owned pane on a non-web client (KTD-2); web and
 *  local panes keep the local adapter. */
export function getNativeChatSessionTransport(
  runtimeEnvironmentId: string | null
): NativeChatSessionTransport {
  if (runtimeEnvironmentId && !isWebClientLocation()) {
    return createRuntimeNativeChatTransport(runtimeEnvironmentId)
  }
  return localNativeChatTransport
}
