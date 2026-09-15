import { RuntimeRpcFailureError, type RuntimeClient } from '../runtime-client'
import type { AskEnvelope } from '../../shared/fork-ask-question-tool/ask-answer-envelope'
import { resolveAskWaitClientTimeoutMs } from '../../shared/fork-ask-question-tool/ask-question-schema'
import { callWithTransportRetry } from './ask-cli-transport-retry'

type AskWaitCapacityEnvelope = {
  status: 'pending'
  askId: string
  code: 'runtime_busy'
  reason: string
  instruction: string
}

/**
 * Blocks on one `ask.wait` chunk, retrying against the same `askId` on a bare transport
 * failure (wait-resume, never a second ask — tech.md C5, item 6).
 */
export async function waitAskChunkWithRetry(
  client: RuntimeClient,
  askId: string,
  chunkMs: number | undefined
): Promise<AskEnvelope | AskWaitCapacityEnvelope> {
  try {
    const response = await callWithTransportRetry(() =>
      client.call<AskEnvelope>(
        'ask.wait',
        { askId, chunkMs },
        { timeoutMs: resolveAskWaitClientTimeoutMs(chunkMs) }
      )
    )
    return response.result
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError && error.code === 'runtime_busy') {
      // Capacity sheds this wait attempt, not the durable ask it was observing.
      return {
        status: 'pending',
        askId,
        code: 'runtime_busy',
        reason: 'Orca ask wait capacity reached; retry with backoff',
        instruction: `orca ask wait --id ${askId}`
      }
    }
    throw error
  }
}
