// Bounds a decoded transcript slice to a byte budget before it crosses a relay
// frame. Independent of the mobile block-clipping policy in
// runtime/rpc/methods/native-chat.ts: that one is about what a phone can render,
// this one is about what the relay's shared writer queue will admit.

import type { NativeChatBlock, NativeChatMessage } from '../../../shared/native-chat-types'

// The relay's control queue is 1MB and its producer queue 2MB, both shared with
// pty output; an over-budget response fails its own request and an over-budget
// control frame closes the client. Stay far enough under that a busy terminal
// on the same connection cannot push a chat read over the line.
export const NATIVE_CHAT_RELAY_BYTE_BUDGET = 256 * 1024

const TRUNCATION_MARKER = '… (truncated)'
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER)
// JSON-escaping can inflate a body past its raw byte length (a string of quotes
// doubles), so the allocation below is re-checked and retightened this many times.
const CLIP_REFINEMENT_PASSES = 4

export function estimateNativeChatMessageBytes(message: NativeChatMessage): number {
  return Buffer.byteLength(JSON.stringify(message))
}

/** Truncate to a byte budget without leaving a split multi-byte character. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) {
    return text
  }
  let end = maxBytes
  while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) {
    end--
  }
  if (end > 0 && (buffer[end - 1]! & 0x80) !== 0) {
    end--
  }
  return buffer.subarray(0, end).toString('utf8')
}

function isClippable(block: NativeChatBlock): boolean {
  return block.type === 'text' || block.type === 'tool-result' || block.type === 'tool-call'
}

/** A tool-call's body lives in `input: unknown`; the renderer only previews it,
 *  so a clipped call carries the serialized prefix as a string. */
function toolCallInputText(input: unknown): string {
  return typeof input === 'string' ? input : (JSON.stringify(input) ?? '')
}

function clipBlockToBytes(block: NativeChatBlock, bodyBytes: number): NativeChatBlock {
  if (block.type === 'text') {
    const text = truncateToBytes(block.text, bodyBytes)
    return text === block.text ? block : { ...block, text: `${text}${TRUNCATION_MARKER}` }
  }
  if (block.type === 'tool-result') {
    const output = truncateToBytes(block.output, bodyBytes)
    return output === block.output ? block : { ...block, output: `${output}${TRUNCATION_MARKER}` }
  }
  if (block.type === 'tool-call') {
    const serialized = toolCallInputText(block.input)
    const input = truncateToBytes(serialized, bodyBytes)
    return input === serialized ? block : { ...block, input: `${input}${TRUNCATION_MARKER}` }
  }
  return block
}

function emptyBody(block: NativeChatBlock): NativeChatBlock {
  if (block.type === 'text') {
    return { ...block, text: '' }
  }
  if (block.type === 'tool-result') {
    return { ...block, output: '' }
  }
  if (block.type === 'tool-call') {
    return { ...block, input: '' }
  }
  return block
}

/**
 * Shrink a single message to fit `maxBytes` by clipping its body-bearing blocks
 * — text, tool-result output, and tool-call input. A transcript record may
 * legally reach 2MB, so one message can exceed a whole frame budget on its own,
 * and dropping it would lose the turn the user is reading.
 *
 * Returns the message unchanged only when it carries no such block, in which
 * case its size is envelope and image references and cannot be given back.
 */
export function clipNativeChatMessageToBytes(
  message: NativeChatMessage,
  maxBytes: number
): NativeChatMessage {
  if (estimateNativeChatMessageBytes(message) <= maxBytes) {
    return message
  }
  const clippable = message.blocks.filter(isClippable).length
  if (clippable === 0) {
    return message
  }
  // Charge the envelope (ids, roles, block scaffolding) and one marker per
  // clippable block before dividing what is left between the bodies.
  const envelope = estimateNativeChatMessageBytes({
    ...message,
    blocks: message.blocks.map(emptyBody)
  })
  let bodyBytes = Math.floor(
    Math.max(0, maxBytes - envelope - clippable * TRUNCATION_MARKER_BYTES) / clippable
  )
  let clipped = message
  for (let pass = 0; pass < CLIP_REFINEMENT_PASSES; pass++) {
    clipped = {
      ...message,
      blocks: message.blocks.map((block) => clipBlockToBytes(block, bodyBytes))
    }
    const size = estimateNativeChatMessageBytes(clipped)
    if (size <= maxBytes || bodyBytes === 0) {
      return clipped
    }
    // Re-tighten by the observed overshoot rather than guessing at escape cost.
    bodyBytes = Math.max(0, Math.floor(bodyBytes - (size - maxBytes) / clippable) - 1)
  }
  return clipped
}

export type NativeChatWireBudgetResult = {
  messages: NativeChatMessage[]
  /** True when older messages were dropped to fit, so the caller must report `hasMore`. */
  droppedOlder: boolean
}

/** A decoded turn paired with the byte offset it starts at in the transcript. */
export type NativeChatTailEntry = { message: NativeChatMessage; offset: number }

/**
 * Keep the newest entries that fit `maxBytes`, dropping older ones.
 *
 * Offset-carrying variant: the caller needs the surviving oldest entry's offset
 * to page further back, and the pre-budget offset would point past turns this
 * dropped.
 *
 * Guarantees at least one entry whenever the input is non-empty — a lone
 * oversized turn is clipped rather than dropped, so the pane never renders empty
 * because one record was too big.
 */
export function budgetNativeChatTailEntries(
  entries: readonly NativeChatTailEntry[],
  maxBytes: number = NATIVE_CHAT_RELAY_BYTE_BUDGET
): { entries: NativeChatTailEntry[]; droppedOlder: boolean } {
  if (entries.length === 0) {
    return { entries: [], droppedOlder: false }
  }
  const kept: NativeChatTailEntry[] = []
  let used = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    const size = estimateNativeChatMessageBytes(entry.message)
    if (used + size > maxBytes) {
      if (kept.length > 0) {
        return { entries: kept, droppedOlder: true }
      }
      // Newest message alone exceeds the budget: clip it so the turn still shows.
      return {
        entries: [
          { message: clipNativeChatMessageToBytes(entry.message, maxBytes), offset: entry.offset }
        ],
        droppedOlder: index > 0
      }
    }
    used += size
    kept.unshift(entry)
  }
  return { entries: kept, droppedOlder: false }
}

/** Offset-free wrapper for callers that only ship messages over the wire. */
export function budgetNativeChatTail(
  messages: readonly NativeChatMessage[],
  maxBytes: number = NATIVE_CHAT_RELAY_BYTE_BUDGET
): NativeChatWireBudgetResult {
  const budgeted = budgetNativeChatTailEntries(
    messages.map((message) => ({ message, offset: 0 })),
    maxBytes
  )
  return {
    messages: budgeted.entries.map((entry) => entry.message),
    droppedOlder: budgeted.droppedOlder
  }
}
