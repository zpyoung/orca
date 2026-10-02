import { describe, expect, it } from 'vitest'
import type { ApprovalScope } from '../../shared/fork-heimdall/ledger-types'
import { pipelineChoiceAnswerCommand } from './pipeline-choice-answer'

const PIPELINE_SCOPE: ApprovalScope = {
  actionKind: 'pipeline-pass-gate',
  contentIdentity: 'pipeline:sha256:abc',
  evidenceKey: '["node","gate",0,0,"choice:gate"]'
}
const ORDINARY_SCOPE: ApprovalScope = {
  actionKind: 'write',
  contentIdentity: 'content-1',
  evidenceKey: 'evidence-1'
}

describe('pipeline CLI choice answers', () => {
  it('builds a send-back command with a trimmed comment', () => {
    expect(
      pipelineChoiceAnswerCommand(
        PIPELINE_SCOPE,
        new Map([
          ['choice', 'send-back'],
          ['comment', ' split step 6 ']
        ])
      )
    ).toEqual({
      kind: 'answer-pipeline-choice',
      scope: PIPELINE_SCOPE,
      choice: 'send-back',
      comment: 'split step 6'
    })
  })

  it('defaults pipeline approvals to approve', () => {
    expect(pipelineChoiceAnswerCommand(PIPELINE_SCOPE, new Map())).toEqual({
      kind: 'answer-pipeline-choice',
      scope: PIPELINE_SCOPE,
      choice: 'approve'
    })
  })

  it('requires a send-back comment and an extend duration', () => {
    expect(() =>
      pipelineChoiceAnswerCommand(PIPELINE_SCOPE, new Map([['choice', 'send-back']]))
    ).toThrow('--choice send-back requires --comment.')
    expect(() =>
      pipelineChoiceAnswerCommand(PIPELINE_SCOPE, new Map([['choice', 'extend']]))
    ).toThrow('--choice extend requires --extend-minutes.')
    expect(
      pipelineChoiceAnswerCommand(
        PIPELINE_SCOPE,
        new Map([
          ['choice', 'extend'],
          ['extend-minutes', '1440']
        ])
      )
    ).toMatchObject({ kind: 'answer-pipeline-choice', choice: 'extend', extendMinutes: 1_440 })
  })

  it('rejects choices outside the pipeline vocabulary and out-of-range durations', () => {
    expect(() =>
      pipelineChoiceAnswerCommand(PIPELINE_SCOPE, new Map([['choice', 'merge']]))
    ).toThrow('Invalid pipeline choice "merge".')
    expect(() =>
      pipelineChoiceAnswerCommand(
        PIPELINE_SCOPE,
        new Map([
          ['choice', 'extend'],
          ['extend-minutes', '1441']
        ])
      )
    ).toThrow('--extend-minutes must be from 1 to 1440.')
  })

  it('preserves ordinary approvals and rejects non-approve choices on them', () => {
    expect(pipelineChoiceAnswerCommand(ORDINARY_SCOPE, new Map())).toBeNull()
    expect(pipelineChoiceAnswerCommand(ORDINARY_SCOPE, new Map([['choice', 'approve']]))).toBeNull()
    expect(() =>
      pipelineChoiceAnswerCommand(ORDINARY_SCOPE, new Map([['choice', 'send-back']]))
    ).toThrow('--choice is supported only for pipeline gates and choices.')
  })
})
