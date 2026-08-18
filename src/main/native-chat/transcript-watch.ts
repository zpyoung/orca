import type { NativeChatMessage } from '../../shared/native-chat-types'
import { subscribeNativeChatTranscriptWithDecoder } from './fork-native-chat-relay/transcript-watch-subscription'
import type {
  NativeChatTranscriptSubscription,
  NativeChatTranscriptTailReader,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'

export { readNativeChatTranscriptTail } from './transcript-tail-reader'
export { getActiveNativeChatWatcherCount } from './transcript-watch-engine'
export type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'

const defaultTailReader: NativeChatTranscriptTailReader = (args) =>
  readNativeChatTranscriptTailFile(
    args.filePath,
    args.limit,
    args.decode,
    args.includeTrailingLine,
    args.endOffset,
    args.decodeLifecycle,
    args.signal
  )

/**
 * Subscribe to live transcript updates, falling back to polling while a session file is unresolved.
 *
 * The returned teardown is always safe to call, even when no watchable transcript exists.
 */
export async function subscribeNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal
): Promise<NativeChatTranscriptSubscription> {
  const decode: ((line: string, fallbackId: string) => NativeChatMessage | null) | null =
    nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    return { unsubscribe: () => {}, watching: false }
  }
  return subscribeNativeChatTranscriptWithDecoder(
    { ...args, tailReader: defaultTailReader },
    decode,
    setupSignal
  )
}
