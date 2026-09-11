import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveClaudeSuppressionVerdict,
  setLocalClaudeSuppressionVerdictReader,
  type ClaudeSuppressionVerdict
} from '../../../../shared/fork-ask-question-tool/claude-suppression-verdict'
import { wireClaudeSuppressionVerdict } from './claude-suppression-verdict-bridge'

const FLAGS = ['--disallowedTools', 'AskUserQuestion']

function stubApi(initial: Promise<ClaudeSuppressionVerdict>) {
  let push: ((verdict: ClaudeSuppressionVerdict) => void) | undefined
  const stopListening = vi.fn()
  const api = {
    getSuppressionVerdict: vi.fn(() => initial),
    onSuppressionVerdict: vi.fn((callback: (verdict: ClaudeSuppressionVerdict) => void) => {
      push = callback
      return stopListening
    })
  }
  return { api, stopListening, push: (verdict: ClaudeSuppressionVerdict) => push?.(verdict) }
}

afterEach(() => {
  setLocalClaudeSuppressionVerdictReader(null)
})

describe('wireClaudeSuppressionVerdict', () => {
  it('reads pending until the first value arrives', () => {
    const { api } = stubApi(Promise.resolve('pending'))

    wireClaudeSuppressionVerdict(api)

    expect(resolveClaudeSuppressionVerdict({})).toBe('pending')
  })

  it('adopts the fetched verdict', async () => {
    const { api } = stubApi(Promise.resolve(FLAGS))

    wireClaudeSuppressionVerdict(api)

    await vi.waitFor(() => expect(resolveClaudeSuppressionVerdict({})).toEqual(FLAGS))
  })

  it('adopts a pushed verdict', () => {
    const { api, push } = stubApi(Promise.resolve('pending'))
    wireClaudeSuppressionVerdict(api)

    push(FLAGS)

    expect(resolveClaudeSuppressionVerdict({})).toEqual(FLAGS)
  })

  it('does not let a late initial fetch overwrite a verdict already pushed', async () => {
    let settle: (verdict: ClaudeSuppressionVerdict) => void = () => undefined
    const { api, push } = stubApi(
      new Promise<ClaudeSuppressionVerdict>((resolve) => {
        settle = resolve
      })
    )
    wireClaudeSuppressionVerdict(api)
    push(FLAGS)

    settle('pending')
    await Promise.resolve()

    expect(resolveClaudeSuppressionVerdict({})).toEqual(FLAGS)
  })

  it('survives a rejected fetch and keeps reporting pending', async () => {
    const { api } = stubApi(Promise.reject(new Error('no host')))

    wireClaudeSuppressionVerdict(api)
    await Promise.resolve()

    expect(resolveClaudeSuppressionVerdict({})).toBe('pending')
  })

  it('unregisters itself and the listener on dispose', async () => {
    const { api, stopListening } = stubApi(Promise.resolve(FLAGS))
    const dispose = wireClaudeSuppressionVerdict(api)
    await vi.waitFor(() => expect(resolveClaudeSuppressionVerdict({})).toEqual(FLAGS))

    dispose()

    expect(stopListening).toHaveBeenCalledOnce()
    expect(resolveClaudeSuppressionVerdict({})).toBe('pending')
  })
})
