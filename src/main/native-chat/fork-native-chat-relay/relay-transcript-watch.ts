import { subscribeNativeChatTranscriptWithDecoder } from './transcript-watch-subscription'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from '../transcript-watch-contract'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTail,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'

export { readNativeChatTranscriptTail }
export type { NativeChatTranscriptSubscription }

export function subscribeRelayNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs
): Promise<NativeChatTranscriptSubscription> {
  const decode = nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    return Promise.resolve({ watching: false, unsubscribe: () => {} })
  }
  return subscribeNativeChatTranscriptWithDecoder(
    { ...args, tailReader: readNativeChatTranscriptTailFile },
    decode
  )
}
