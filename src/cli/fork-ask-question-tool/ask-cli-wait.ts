import type { RuntimeClient } from '../runtime-client'
import type { AskEnvelope } from '../../shared/fork-ask-question-tool/ask-answer-envelope'
import { resolveAskWaitClientTimeoutMs } from '../../shared/fork-ask-question-tool/ask-question-schema'
import { callWithTransportRetry } from './ask-cli-transport-retry'

/**
 * Blocks on one `ask.wait` chunk, retrying against the same `askId` on a bare transport
 * failure (wait-resume, never a second ask — tech.md C5, item 6).
 */
export async function waitAskChunkWithRetry(
  client: RuntimeClient,
  askId: string,
  chunkMs: number | undefined
): Promise<AskEnvelope> {
  const response = await callWithTransportRetry(() =>
    client.call<AskEnvelope>(
      'ask.wait',
      { askId, chunkMs },
      { timeoutMs: resolveAskWaitClientTimeoutMs(chunkMs) }
    )
  )
  return response.result
}
