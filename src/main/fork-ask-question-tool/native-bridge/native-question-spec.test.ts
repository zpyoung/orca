import { describe, expect, it } from 'vitest'
import type { AskResultBody } from '../../../shared/fork-ask-question-tool/ask-answer-envelope'
import { ClaudePromptRegistry } from '../../claude/claude-prompt-registry'
import {
  buildClaudePromptReply,
  encodeClaudeQuestionOptionId
} from '../../claude/claude-structured-prompt-replies'
import {
  askResultToClaudeAnswers,
  askResultToCodexAnswers,
  claudeQuestionsToAskSpec,
  codexParamsToAskSpec,
  NO_OWNER_ANSWER
} from './native-question-spec'

const CLAUDE_INPUT = {
  questions: [
    {
      question: 'Which database?',
      header: 'Database',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'relational' },
        { label: 'SQLite, embedded', description: 'file based' }
      ]
    },
    {
      question: 'Which checks should run?',
      header: 'Checks',
      multiSelect: true,
      options: [{ label: 'lint' }, { label: 'typecheck' }, { label: 'unit' }]
    }
  ]
}

function result(answers: AskResultBody['answers'], skipped: string[] = []): AskResultBody {
  return { answers, skipped, summary: '' }
}

function convertOk(conversion: ReturnType<typeof claudeQuestionsToAskSpec>) {
  if (!conversion.ok) {
    throw new Error(`expected a conversion, got: ${conversion.reason}`)
  }
  return conversion
}

describe('claudeQuestionsToAskSpec', () => {
  it('maps single and multi select questions onto synthetic option values', () => {
    const { spec, bindings } = convertOk(claudeQuestionsToAskSpec(CLAUDE_INPUT))

    expect(spec.questions).toEqual([
      {
        id: 'q1',
        header: 'Database',
        type: 'select',
        question: 'Which database?',
        options: [
          { value: 'o1', label: 'Postgres', description: 'relational' },
          { value: 'o2', label: 'SQLite, embedded', description: 'file based' }
        ]
      },
      expect.objectContaining({
        id: 'q2',
        type: 'multiselect',
        options: [
          { value: 'o1', label: 'lint' },
          { value: 'o2', label: 'typecheck' },
          { value: 'o3', label: 'unit' }
        ]
      })
    ])
    expect(bindings).toEqual([
      { askQuestionId: 'q1', providerKey: 'Which database?', multiple: false },
      { askQuestionId: 'q2', providerKey: 'Which checks should run?', multiple: true }
    ])
  })

  it('turns an option-less question into free text keyed by its header when it has no text', () => {
    const { spec, bindings } = convertOk(
      claudeQuestionsToAskSpec({ questions: [{ header: 'Branch name' }] })
    )

    expect(spec.questions).toEqual([
      { id: 'q1', header: 'Branch name', type: 'text', question: 'Branch name' }
    ])
    expect(bindings[0]?.providerKey).toBe('Branch name')
  })

  it('degrades an over-long option list to text that still names every option', () => {
    const options = Array.from({ length: 13 }, (_, index) => ({ label: `choice ${index + 1}` }))
    const { spec } = convertOk(
      claudeQuestionsToAskSpec({ questions: [{ question: 'Pick one', options }] })
    )

    expect(spec.questions[0]).toMatchObject({ type: 'text' })
    expect(spec.questions[0]?.question).toContain('choice 13')
  })

  it('refuses more questions than an ask can carry', () => {
    const questions = Array.from({ length: 11 }, (_, index) => ({ question: `Question ${index}` }))
    expect(claudeQuestionsToAskSpec({ questions })).toMatchObject({ ok: false })
  })

  it('refuses input with no questions', () => {
    expect(claudeQuestionsToAskSpec({})).toMatchObject({ ok: false })
  })

  it('surfaces ask-spec validation failures as the refusal reason', () => {
    const conversion = claudeQuestionsToAskSpec({
      questions: [{ question: 'Paste your password' }]
    })
    expect(conversion).toMatchObject({ ok: false, reason: expect.stringContaining('credential') })
  })
})

describe('askResultToClaudeAnswers', () => {
  it('answers with labels, an array for multi-select, and matches the card reply shape', () => {
    const { bindings } = convertOk(claudeQuestionsToAskSpec(CLAUDE_INPUT))
    const answers = askResultToClaudeAnswers(
      bindings,
      result({
        q1: { value: 'o2', label: 'SQLite, embedded', source: 'option' },
        q2: { values: ['o1', 'o3'], labels: ['lint', 'unit'], source: 'options' }
      })
    )

    const prompts = new ClaudePromptRegistry()
    const prompt = prompts.register({
      requestId: 'request-1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-1',
      input: CLAUDE_INPUT,
      suggestions: [],
      settle: () => undefined
    })
    if (!prompt) {
      throw new Error('prompt should register')
    }
    const cardReply = buildClaudePromptReply(prompt, {
      kind: 'answers',
      answers: [
        { questionId: 'q1', optionIds: [encodeClaudeQuestionOptionId('q1', 'choice-2')] },
        {
          questionId: 'q2',
          optionIds: [
            encodeClaudeQuestionOptionId('q2', 'choice-1'),
            encodeClaudeQuestionOptionId('q2', 'choice-3')
          ]
        }
      ]
    })

    expect(cardReply).toMatchObject({ behavior: 'allow', updatedInput: { answers } })
  })

  it('passes free text through and fills a skipped question with the no-answer placeholder', () => {
    const { bindings } = convertOk(claudeQuestionsToAskSpec(CLAUDE_INPUT))
    const answers = askResultToClaudeAnswers(
      bindings,
      result({ q1: { value: 'MySQL', source: 'other' } }, ['q2'])
    )

    expect(answers).toEqual({
      'Which database?': 'MySQL',
      'Which checks should run?': [NO_OWNER_ANSWER]
    })
  })
})

describe('codexParamsToAskSpec', () => {
  const params = {
    threadId: 'thread-1',
    itemId: 'item-1',
    questions: [
      {
        id: 'target',
        header: 'Target',
        question: 'Deploy where?',
        options: [{ label: 'staging' }, { label: 'Other', isOther: true }]
      },
      { id: 'reason', question: 'Why?' },
      { question: 'no id, so Codex never tracks it' }
    ]
  }

  it('keys bindings by the Codex question id and drops the free-text option', () => {
    const conversion = codexParamsToAskSpec(params)
    if (!conversion.ok) {
      throw new Error(conversion.reason)
    }

    expect(conversion.spec.questions).toEqual([
      {
        id: 'q1',
        header: 'Target',
        type: 'select',
        question: 'Deploy where?',
        options: [{ value: 'o1', label: 'staging' }]
      },
      { id: 'q2', type: 'text', question: 'Why?' }
    ])
    expect(conversion.bindings.map((binding) => binding.providerKey)).toEqual(['target', 'reason'])
  })

  it('refuses a request carrying a secret question', () => {
    const secret = { questions: [{ id: 'key', question: 'Enter it', isSecret: true }] }
    expect(codexParamsToAskSpec(secret)).toMatchObject({ ok: false })
  })

  it('answers every Codex question with one string, placeholder when skipped', () => {
    const conversion = codexParamsToAskSpec(params)
    if (!conversion.ok) {
      throw new Error(conversion.reason)
    }

    expect(
      askResultToCodexAnswers(
        conversion.bindings,
        result({ q1: { value: 'o1', label: 'staging', source: 'option' } }, ['q2'])
      )
    ).toEqual({ target: 'staging', reason: NO_OWNER_ANSWER })
  })
})
