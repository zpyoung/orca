import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import {
  budgetNativeChatTail,
  clipNativeChatMessageToBytes,
  estimateNativeChatMessageBytes
} from './transcript-wire-budget'

function message(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('budgetNativeChatTail', () => {
  it('keeps everything when the slice already fits', () => {
    const messages = [message('a', 'one'), message('b', 'two')]

    const result = budgetNativeChatTail(messages, 10_000)

    expect(result.messages.map((m) => m.id)).toEqual(['a', 'b'])
    expect(result.droppedOlder).toBe(false)
  })

  it('drops the oldest messages and reports it', () => {
    const messages = [message('old', 'x'.repeat(400)), message('new', 'y'.repeat(400))]

    const result = budgetNativeChatTail(messages, 600)

    expect(result.messages.map((m) => m.id)).toEqual(['new'])
    expect(result.droppedOlder).toBe(true)
  })

  it('preserves chronological order in the kept window', () => {
    const messages = ['a', 'b', 'c', 'd'].map((id) => message(id, 'z'.repeat(200)))

    const result = budgetNativeChatTail(messages, 700)

    expect(result.messages.map((m) => m.id)).toEqual(['c', 'd'])
  })

  // A transcript record may legally reach 2MB. Dropping it would blank the very
  // turn the user is looking at, so it gets clipped down instead.
  it('clips a lone oversized message rather than dropping it', () => {
    const result = budgetNativeChatTail([message('huge', 'x'.repeat(50_000))], 1_000)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]!.id).toBe('huge')
    expect(estimateNativeChatMessageBytes(result.messages[0]!)).toBeLessThanOrEqual(1_000)
  })

  it('reports droppedOlder when an oversized newest message hid older ones', () => {
    const result = budgetNativeChatTail(
      [message('older', 'a'), message('huge', 'x'.repeat(50_000))],
      1_000
    )

    expect(result.messages.map((m) => m.id)).toEqual(['huge'])
    expect(result.droppedOlder).toBe(true)
  })

  it('returns nothing for an empty transcript', () => {
    expect(budgetNativeChatTail([], 1_000)).toEqual({ messages: [], droppedOlder: false })
  })
})

describe('clipNativeChatMessageToBytes', () => {
  it('leaves a message that already fits untouched', () => {
    const original = message('a', 'short')

    expect(clipNativeChatMessageToBytes(original, 10_000)).toBe(original)
  })

  it('splits the budget across text-bearing blocks', () => {
    const original: NativeChatMessage = {
      id: 'a',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'x'.repeat(20_000) },
        { type: 'tool-result', output: 'y'.repeat(20_000) }
      ],
      timestamp: 1,
      source: 'transcript'
    }

    const clipped = clipNativeChatMessageToBytes(original, 2_000)

    expect(estimateNativeChatMessageBytes(clipped)).toBeLessThanOrEqual(2_000)
    expect(clipped.blocks).toHaveLength(2)
  })

  // Cutting at a byte boundary mid-codepoint would emit U+FFFD into the pane.
  it('never splits a multi-byte character', () => {
    const clipped = clipNativeChatMessageToBytes(message('a', '🙂'.repeat(2_000)), 900)

    expect(estimateNativeChatMessageBytes(clipped)).toBeLessThanOrEqual(900)
    expect(JSON.stringify(clipped)).not.toContain('�')
  })

  it('leaves a message with no clippable block alone rather than corrupting it', () => {
    const original: NativeChatMessage = {
      id: 'a',
      role: 'user',
      blocks: [{ type: 'image-ref', path: '/tmp/big.png' }],
      timestamp: 1,
      source: 'transcript'
    }

    expect(clipNativeChatMessageToBytes(original, 4)).toBe(original)
  })

  // A tool call carrying a whole file body is the realistic oversized turn with
  // no text block; leaving it whole would push the frame over its budget.
  it('clips a tool-call input, which is a message body like any other', () => {
    const original: NativeChatMessage = {
      id: 'a',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'Write', input: { content: 'x'.repeat(20_000) } }],
      timestamp: 1,
      source: 'transcript'
    }

    const clipped = clipNativeChatMessageToBytes(original, 2_000)

    expect(estimateNativeChatMessageBytes(clipped)).toBeLessThanOrEqual(2_000)
    expect(clipped.blocks[0]).toMatchObject({ type: 'tool-call', name: 'Write' })
  })

  it('leaves a tool-call input that already fits untouched and structured', () => {
    const original: NativeChatMessage = {
      id: 'a',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'Read', input: { path: '/tmp/a.ts' } }],
      timestamp: 1,
      source: 'transcript'
    }

    expect(clipNativeChatMessageToBytes(original, 10_000)).toBe(original)
  })
})
