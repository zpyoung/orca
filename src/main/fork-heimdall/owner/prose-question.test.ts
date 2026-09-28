import { describe, expect, it } from 'vitest'
import { looksLikeProseQuestion } from './prose-question'

describe('looksLikeProseQuestion', () => {
  it.each([
    'I finished the migration.\n\nShould I also update the docs?',
    'Two ways forward:\n\n1) keep the cache\n2) drop it\nWhich do you want?',
    'Tests pass. Want me to open the PR, or wait for review?'
  ])('matches a question left for someone to answer: %s', (message) => {
    expect(looksLikeProseQuestion(message)).toBe(true)
  })

  it.each([
    null,
    '',
    'Done. All 42 tests pass.',
    'Is this right? I checked, and it is.\n\nAll done; nothing left to do.',
    'Run this:\n\n```sh\nwhat? || echo which?\n```',
    '???'
  ])('does not match a message with no open question: %s', (message) => {
    expect(looksLikeProseQuestion(message)).toBe(false)
  })
})
