import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveClaudeSuppressionVerdict,
  setLocalClaudeSuppressionVerdictReader,
  type ClaudeSuppressionVerdict
} from './claude-suppression-verdict'

const FLAGS = ['--disallowedTools', 'AskUserQuestion']

afterEach(() => {
  setLocalClaudeSuppressionVerdictReader(null)
})

describe('resolveClaudeSuppressionVerdict', () => {
  it('reports pending when no process has registered a reader', () => {
    expect(resolveClaudeSuppressionVerdict({})).toBe('pending')
  })

  it('reads the ambient local verdict for a local launch', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    expect(resolveClaudeSuppressionVerdict({})).toEqual(FLAGS)
  })

  it('reads the reader on every call so a verdict that lands later is picked up', () => {
    let current: ClaudeSuppressionVerdict = 'pending'
    setLocalClaudeSuppressionVerdictReader(() => current)
    expect(resolveClaudeSuppressionVerdict({})).toBe('pending')

    current = FLAGS
    expect(resolveClaudeSuppressionVerdict({})).toEqual(FLAGS)
  })

  it('keeps a reader-supplied null distinct from having no reader at all', () => {
    setLocalClaudeSuppressionVerdictReader(() => null)

    expect(resolveClaudeSuppressionVerdict({})).toBeNull()
  })

  it('never applies the local verdict to a remote launch', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    expect(resolveClaudeSuppressionVerdict({ isRemote: true })).toBe('pending')
  })

  it('prefers an explicit verdict over the ambient reader, including an explicit null', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    expect(resolveClaudeSuppressionVerdict({ explicit: null })).toBeNull()
    expect(resolveClaudeSuppressionVerdict({ explicit: [], isRemote: true })).toEqual([])
  })
})
