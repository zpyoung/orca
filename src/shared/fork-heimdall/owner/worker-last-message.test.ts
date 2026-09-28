import { describe, expect, it } from 'vitest'
import { clipWorkerLastMessage, WORKER_LAST_MESSAGE_MAX_BYTES } from './worker-last-message'

describe('clipWorkerLastMessage', () => {
  it('keeps a short message whole', () => {
    expect(clipWorkerLastMessage('  Which branch?  ')).toEqual({
      text: 'Which branch?',
      truncated: false
    })
  })

  it('keeps the newest bytes, where the question is', () => {
    const clipped = clipWorkerLastMessage(`${'a'.repeat(10_000)}\nWhich option do you prefer?`)
    expect(clipped.truncated).toBe(true)
    expect(clipped.text.endsWith('Which option do you prefer?')).toBe(true)
    expect(new TextEncoder().encode(clipped.text).byteLength).toBeLessThanOrEqual(
      WORKER_LAST_MESSAGE_MAX_BYTES
    )
  })

  it('never splits a multi-byte character into a replacement glyph', () => {
    const clipped = clipWorkerLastMessage('é'.repeat(3_000), 101)
    expect(clipped.text).not.toContain('�')
    expect(clipped.text).toBe('é'.repeat(50))
  })
})
