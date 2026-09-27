import { ipcRenderer } from 'electron'
import type {
  NativeChatAppendedPayload,
  NativeChatReadSessionArgs,
  NativeChatReadSessionResult,
  NativeChatSubscriptionFrame,
  PreloadApi
} from '../api-types'
import type { AgentType } from '../../shared/native-chat-types'

const readNativeChatSession = (
  argsOrAgent: NativeChatReadSessionArgs | AgentType,
  sessionId?: string,
  limit?: number,
  transcriptPath?: string
): Promise<NativeChatReadSessionResult> =>
  ipcRenderer.invoke(
    'nativeChat:readSession',
    typeof argsOrAgent === 'string'
      ? { agent: argsOrAgent, sessionId: sessionId ?? '', limit, transcriptPath }
      : argsOrAgent
  )

export const nativeChatApi = {
  readSession: readNativeChatSession,
  /** Start live tailing; onAppended fires with only newly-appended messages. Returns an unsubscribe fn that closes the watcher. */
  subscribe: (
    args: {
      subscriptionId: string
      agent: AgentType
      sessionId: string
      transcriptPath?: string
      limit?: number
      sshConnectionId?: string
    },
    onFrame: (frame: NativeChatSubscriptionFrame) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: NativeChatAppendedPayload) => {
      if (payload.subscriptionId === args.subscriptionId) {
        onFrame(payload.frame)
      }
    }
    ipcRenderer.on('nativeChat:appended', listener)
    ipcRenderer.send('nativeChat:subscribe', args)
    return () => {
      ipcRenderer.removeListener('nativeChat:appended', listener)
      ipcRenderer.send('nativeChat:unsubscribe', { subscriptionId: args.subscriptionId })
    }
  }
} satisfies PreloadApi['nativeChat']
