import { describe, expect, it } from 'vitest'
import { AskPaneQueue } from './ask-registry-pane-queue'

describe('AskPaneQueue', () => {
  it('surfaces the first ask on a pane immediately', () => {
    const queue = new AskPaneQueue()
    expect(queue.enqueue('pane:1', 'ask_1')).toBe(true)
    expect(queue.head('pane:1')).toBe('ask_1')
  })

  it('queues a second ask on the same pane behind the head', () => {
    const queue = new AskPaneQueue()
    queue.enqueue('pane:1', 'ask_1')
    expect(queue.enqueue('pane:1', 'ask_2')).toBe(false)
    expect(queue.head('pane:1')).toBe('ask_1')
  })

  it('promotes the next ask only when the head resolves', () => {
    const queue = new AskPaneQueue()
    queue.enqueue('pane:1', 'ask_1')
    queue.enqueue('pane:1', 'ask_2')
    expect(queue.remove('pane:1', 'ask_1')).toBe('ask_2')
    expect(queue.head('pane:1')).toBe('ask_2')
  })

  it('does not promote anyone when a non-head ask resolves', () => {
    const queue = new AskPaneQueue()
    queue.enqueue('pane:1', 'ask_1')
    queue.enqueue('pane:1', 'ask_2')
    expect(queue.remove('pane:1', 'ask_2')).toBeNull()
    expect(queue.head('pane:1')).toBe('ask_1')
  })

  it('clears the pane entry once its queue empties', () => {
    const queue = new AskPaneQueue()
    queue.enqueue('pane:1', 'ask_1')
    queue.remove('pane:1', 'ask_1')
    expect(queue.head('pane:1')).toBeUndefined()
  })

  it('is a no-op for an unknown pane or ask id', () => {
    const queue = new AskPaneQueue()
    expect(queue.remove('pane:none', 'ask_1')).toBeNull()
    queue.enqueue('pane:1', 'ask_1')
    expect(queue.remove('pane:1', 'ask_missing')).toBeNull()
  })

  it('tracks independent panes separately', () => {
    const queue = new AskPaneQueue()
    expect(queue.enqueue('pane:1', 'ask_1')).toBe(true)
    expect(queue.enqueue('pane:2', 'ask_2')).toBe(true)
  })
})
